// Before anything changes: read what the site declares (wrangler.jsonc) and what
// exists on the account, decide names, account and inputs. Only reads happen
// here, so `cms deploy --dry-run` is this step plus the plan.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { bootstrapState } from "../../bootstrap-state.js";
import type { AdminCredentials } from "../../bootstrap.js";
import { CloudflareError, type AccountApi, type LifecycleRule } from "../../cloudflare/port.js";
import type { Ctx } from "../../frame/context.js";
import { CliError } from "../../frame/errors.js";
import { MANAGED_SECRETS, SETUP_TOKEN } from "../../secrets.js";
import { namingState, resourcesForName } from "../../site/naming.js";
import { PAGE_CACHE_BINDING, pageCacheVerdict, type PageCacheVerdict } from "../../site/page-cache.js";
import { readConfigText, siteFromText, type Site } from "../../site/site.js";
import { readWranglerConfig, writeSiteResources } from "../../wrangler-config.js";
import { againCommand, connect, type ChosenAccount } from "../connect.js";
import { settingsChecks, type Check } from "../doctor-checks.js";
import { adminInputs, setupTokenInput, siteNameInput } from "./inputs.js";
import { hasWrangler, wranglerSignedIn } from "./project.js";

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;

export interface D1Target {
  name: string;
  bindings: string[];
  /** Id on the account; undefined when it has to be created. */
  existingId?: string;
  /** wrangler.jsonc needs this id written. */
  writeId: boolean;
  migrationsDir?: string;
  /** Migration files not yet applied (all of them for a new database). */
  pending: string[];
}

export interface Inspection {
  site: Site;
  /** The new wrangler.jsonc text when the site name is set now; null when unchanged. */
  renamedText: string | null;
  account: ChosenAccount;
  /** account_id goes into wrangler.jsonc as part of the plan. */
  writeAccount: boolean;
  api: AccountApi;
  workerExists: boolean;
  d1: D1Target[];
  r2: { name: string; create: boolean }[];
  pageCache: { bucket: string; rules: LifecycleRule[]; verdict: PageCacheVerdict } | null;
  secretsMissing: string[];
  /** null when the database is new or the users table is not there yet. */
  users: number | null;
  credentials: AdminCredentials | null;
  setupToken?: string;
  settings: Check[];
  /** wrangler's own login; null when the project's dependencies are not installed yet. */
  wranglerSignedIn: boolean | null;
}

const USER_COUNT_SQL = "SELECT COUNT(*) AS count FROM users";

async function projectCheck(dir: string): Promise<void> {
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    if (pkg.dependencies?.next && pkg.devDependencies?.["@opennextjs/cloudflare"]) return;
  } catch {
    // reported below
  }
  throw new CliError({
    code: "PROJECT_INVALID",
    message: "This is not a CMS project: package.json must list next and @opennextjs/cloudflare.",
    hint: "Run cms deploy in the site's directory, or create one with `cms init <dir>`.",
    next: ["cms init <dir>"],
  });
}

/** The site with its final names; renames a fresh template in memory only. */
async function namedSite(ctx: Ctx, configPath: string): Promise<{ site: Site; renamedText: string | null }> {
  const text = await readConfigText(configPath);
  const state = namingState(readWranglerConfig(text));
  const given = typeof ctx.values.name === "string" ? ctx.values.name : undefined;
  if (state === "unsafe") {
    throw new CliError({
      code: "CONFIG_INVALID",
      message: "The resource names in wrangler.jsonc do not all derive from vars.CMS_SITE_SLUG; cms deploy will not guess which site this is.",
      hint: "Start from a clean template (`cms init`), or make name, WORKER_SELF_REFERENCE, the D1 and R2 names all cms-<slug>[-db|-storage|-next-cache].",
    });
  }
  if (state === "configured") {
    const site = await siteFromText(ctx.cwd, configPath, text);
    const slug = readWranglerConfig(text).siteSlug;
    if (given && given !== slug) {
      throw new CliError({ code: "BAD_VALUE", message: `This site is named "${slug}"; it is not renamed to "${given}".`, hint: "A different site starts from a clean template." });
    }
    return { site, renamedText: null };
  }
  const name = await siteNameInput(ctx, againCommand(ctx));
  const renamedText = writeSiteResources(text, resourcesForName(name)).text;
  return { site: await siteFromText(ctx.cwd, configPath, renamedText), renamedText };
}

async function migrationFiles(dir: string, migrationsDir: string): Promise<string[]> {
  return (await readdir(path.join(dir, migrationsDir)).catch(() => [] as string[])).filter((f) => f.endsWith(".sql")).sort();
}

async function d1Targets(site: Site, api: AccountApi): Promise<D1Target[]> {
  const byName = new Map((await api.d1List()).map((d) => [d.name, d.id]));
  return Promise.all(
    site.d1.map(async (db): Promise<D1Target> => {
      const existingId = byName.get(db.name);
      const dir = db.migrationsDir;
      const pending = !dir ? [] : existingId ? await api.d1PendingMigrations(existingId, dir) : await migrationFiles(site.dir, dir);
      return { name: db.name, bindings: db.bindings, existingId, writeId: existingId === undefined || db.id !== existingId, migrationsDir: dir, pending };
    }),
  );
}

async function pageCacheOf(site: Site, api: AccountApi, r2: Inspection["r2"]): Promise<Inspection["pageCache"]> {
  const bucket = site.r2.find((b) => b.bindings.includes(PAGE_CACHE_BINDING))?.name;
  if (!bucket) return null;
  const rules = r2.find((b) => b.name === bucket)?.create ? [] : await api.r2LifecycleRules(bucket);
  return { bucket, rules, verdict: pageCacheVerdict(rules) };
}

async function userCount(api: AccountApi, d1: D1Target[]): Promise<number | null> {
  const db = d1.find((d) => d.bindings.includes("DB"));
  if (!db?.existingId) return null;
  try {
    const count = (await api.d1Query(db.existingId, USER_COUNT_SQL))[0]?.count;
    return typeof count === "number" ? count : null;
  } catch (e) {
    if (e instanceof CloudflareError && e.failure === "FAILED") return null; // no users table yet
    throw e;
  }
}

function refuseTakenNames(d1: D1Target[], r2: Inspection["r2"]): void {
  const taken = [...d1.filter((d) => d.existingId).map((d) => d.name), ...r2.filter((b) => !b.create).map((b) => b.name)];
  if (taken.length === 0) return;
  throw new CliError({
    code: "NAME_IN_USE",
    message: `A new site would take over resources that already exist: ${[...new Set(taken)].join(", ")}.`,
    hint: "Another site on this account probably uses this name. Pick another one with --name.",
    next: ["cms deploy --name <another-name>"],
  });
}

async function firstAdmin(ctx: Ctx, site: Site, d1: D1Target[], users: number | null, secretNames: string[] | null) {
  if (users !== null && users > 0) return { credentials: null, setupToken: undefined };
  const credentials = await adminInputs(ctx, againCommand(ctx));
  if (!secretNames?.includes(SETUP_TOKEN)) return { credentials, setupToken: undefined };
  const dbId = d1.find((d) => d.bindings.includes("DB"))?.existingId ?? "";
  const saved = await bootstrapState(site.dir, site.workerName, dbId).read();
  return { credentials, setupToken: await setupTokenInput(ctx, saved, againCommand(ctx)) };
}

export async function inspect(ctx: Ctx): Promise<Inspection> {
  await projectCheck(ctx.cwd);
  const configPath = path.resolve(ctx.cwd, String(ctx.values.config));
  const { site, renamedText } = await namedSite(ctx, configPath);
  const { account } = await connect(ctx, site.accountId);
  const api = ctx.cloudflare().account(account.id);
  const read = await ctx.progress("Reading Cloudflare", async () => {
    const [worker, d1, ...exists] = await Promise.all([api.worker(site.workerName), d1Targets(site, api), ...site.r2.map((b) => api.r2Exists(b.name))]);
    const r2 = site.r2.map((b, i) => ({ name: b.name, create: !exists[i] }));
    const secretNames = worker ? await api.secretNames(site.workerName) : null;
    return { worker, d1, r2, secretNames, pageCache: await pageCacheOf(site, api, r2), users: await userCount(api, d1) };
  });
  if (renamedText !== null) refuseTakenNames(read.d1, read.r2);
  const settings = await settingsChecks(site.dir, configPath, read.secretNames);
  refuseMissingSettings(settings);
  const admin = await firstAdmin(ctx, site, read.d1, read.users, read.secretNames);
  return {
    site,
    renamedText,
    account,
    writeAccount: site.accountId === undefined && ACCOUNT_ID_RE.test(account.id),
    api,
    workerExists: read.worker !== null,
    d1: read.d1,
    r2: read.r2,
    pageCache: read.pageCache,
    secretsMissing: MANAGED_SECRETS.map((m) => m.name).filter((n) => !read.secretNames?.includes(n)),
    users: read.users,
    ...admin,
    settings,
    wranglerSignedIn: hasWrangler(site.dir) ? await wranglerSignedIn(ctx.exec, site.dir) : null,
  };
}

function refuseMissingSettings(checks: readonly Check[]): void {
  const failed = checks.filter((c) => c.status === "fail");
  if (failed.length === 0) return;
  throw new CliError({
    code: "SETTINGS_MISSING",
    message: `Required plugin settings are empty: ${failed.map((c) => c.title.replace(/^Setting /, "")).join(", ")}.`,
    hint: "Values go to vars in wrangler.jsonc; secrets to the Worker (never into wrangler.jsonc, it is committed).",
    next: [...new Set(failed.flatMap((c) => c.next ?? []))],
  });
}
