// Applying the plan, one step at a time.
//
// Worker exists:  dependencies → config → resources → build → upload (not live)
//                 → migrate → go live → secrets → site URL + admin → check
// First deploy:   dependencies → config → resources → build → migrate → deploy
//                 → secrets → site URL + admin → check
// The first-deploy order is the one 0.x used; uploading a version of a Worker
// that does not exist yet was never verified, so it is not relied on.
//
// Every step checks before it acts, so running `cms deploy` again after a failure
// or Ctrl-C continues from what is missing.

import { readFile, writeFile } from "node:fs/promises";
import { CliError } from "../../frame/errors.js";
import type { Ctx } from "../../frame/context.js";
import { pageCacheRuleToAdd } from "../../site/page-cache.js";
import { writeAccountId, writeD1Ids } from "../../wrangler-config.js";
import { namingStateOf } from "../../site/naming.js";
import { plural, shortId } from "../format.js";
import { checkLogin, createFirstAdmin, initSiteUrl, managedSecrets, resolveOrigin, usersNow } from "./finish.js";
import type { Inspection } from "./inspect.js";
import * as tools from "./project.js";
import type { Steps } from "./steps.js";
import { bootstrapState } from "../../bootstrap-state.js";
import { againCommand } from "../connect.js";

/** What has changed so far; turned into data.state when a step fails. */
export interface Progress {
  config: boolean;
  resources: boolean;
  uploaded?: string;
  migrated: boolean;
  live: boolean;
}

export type DeployState = "nothing-changed" | "resources-changed" | "version-uploaded" | "schema-ahead" | "live";

export function stateOf(p: Progress): { state: DeployState; liveSiteChanged: boolean; meaning: string } {
  if (p.live) return { state: "live", liveSiteChanged: true, meaning: "The new version is live; a later step did not finish." };
  if (p.migrated) return { state: "schema-ahead", liveSiteChanged: false, meaning: "Migrations were applied but the new version is not live: the running site uses the new schema with its old code." };
  if (p.uploaded) return { state: "version-uploaded", liveSiteChanged: false, meaning: "A new version was uploaded but takes no traffic; the live site is unchanged." };
  if (p.config || p.resources) return { state: "resources-changed", liveSiteChanged: false, meaning: "Resources or wrangler.jsonc changed; the live site is unchanged." };
  return { state: "nothing-changed", liveSiteChanged: false, meaning: "Nothing was changed." };
}

async function writeConfig(i: Inspection, progress: Progress): Promise<string> {
  let text = await readFile(i.site.configPath, "utf8");
  const done: string[] = [];
  if (i.renamedText !== null) {
    if (namingStateOf(text) !== "fresh") throw new Error("wrangler.jsonc changed since the plan was made; run cms deploy again");
    text = i.renamedText;
    done.push("site name");
  }
  if (i.writeAccount) {
    text = writeAccountId(text, i.account.id).text;
    done.push("account_id");
  }
  if (done.length > 0) {
    await writeFile(i.site.configPath, text, "utf8");
    progress.config = true;
  }
  return done.length > 0 ? done.join(", ") : "unchanged";
}

async function createResources(i: Inspection, progress: Progress, warn: (m: string) => void): Promise<{ detail: string; d1: Inspection["d1"] }> {
  const ids = new Map<string, string>();
  let created = 0;
  const d1: Inspection["d1"] = [];
  for (const db of i.d1) {
    const id = ids.get(db.name) ?? db.existingId ?? (await i.api.d1Create(db.name)).id;
    if (!db.existingId && !ids.has(db.name)) created++;
    ids.set(db.name, id);
    d1.push({ ...db, existingId: id });
  }
  const written = writeD1Ids(await readFile(i.site.configPath, "utf8"), ids);
  if (written.changed.length > 0) await writeFile(i.site.configPath, written.text, "utf8");
  for (const bucket of i.r2.filter((b) => b.create)) {
    await i.api.r2Create(bucket.name);
    created++;
  }
  if (i.pageCache?.verdict.kind === "add") {
    await i.api.r2SetLifecycleRules(i.pageCache.bucket, [...i.pageCache.rules, pageCacheRuleToAdd()]).catch((e: unknown) => {
      warn(`The page-cache lifecycle rule was not added to ${i.pageCache?.bucket}: ${e instanceof Error ? e.message : String(e)}. Old pages stay until it is; cms deploy tries again.`);
    });
  }
  if (created > 0 || written.changed.length > 0) progress.resources = true;
  return { detail: created > 0 ? `${created} created` : "all present", d1 };
}

async function migrate(project: tools.Project, i: Inspection, progress: Progress): Promise<string> {
  const targets = i.d1.filter((d) => d.migrationsDir && d.pending.length > 0);
  for (const db of targets) {
    progress.migrated = true;
    await tools.applyMigrations(project, db.name);
  }
  const count = targets.reduce((n, d) => n + d.pending.length, 0);
  return count > 0 ? `${count} applied` : "none pending";
}

export interface ApplyResult {
  origin: string;
  versionId?: string;
  secretsCreated: string[];
  admin: "created" | "exists";
  siteUrlInitialized: boolean;
}

async function release(steps: Steps, project: tools.Project, i: Inspection, progress: Progress): Promise<{ versionId?: string; targets: string[] }> {
  const failure = (code: string, message: string, hint?: string) => ({ code, message, hint });
  if (i.workerExists) {
    const versionId = await steps.run("Upload", failure("UPLOAD_REJECTED", "The new version was not uploaded", "The live site is unchanged."), async () => {
      const id = await tools.uploadVersion(project);
      progress.uploaded = id;
      return { value: id, detail: `version ${shortId(id)} (not live)` };
    });
    await steps.run("Migrate", failure("MIGRATION_FAILED", "Migrations failed", "The new version is not live."), async () => ({ value: undefined, detail: await migrate(project, i, progress) }));
    await steps.run("Go live", failure("PROMOTE_FAILED", "The new version did not go live"), async () => {
      await i.api.promote(i.site.workerName, versionId);
      progress.live = true;
      return { value: undefined, detail: `version ${shortId(versionId)} at 100%` };
    });
    return { versionId, targets: [] };
  }
  await steps.run("Migrate", failure("MIGRATION_FAILED", "Migrations failed", "Nothing is live yet."), async () => ({ value: undefined, detail: await migrate(project, i, progress) }));
  return steps.run("Deploy", failure("DEPLOY_FAILED", "The Worker was not deployed"), async () => {
    const result = await tools.deployWorker(project);
    progress.live = true;
    return { value: result, detail: result.versionId ? `version ${shortId(result.versionId)}` : "" };
  });
}

/** Dependencies, wrangler's login, config, resources and the build. Returns the inspection with real D1 ids. */
async function prepare(ctx: Ctx, steps: Steps, project: tools.Project, i: Inspection, progress: Progress): Promise<Inspection> {
  await steps.run("Dependencies", { code: "DEPENDENCIES_FAILED", message: "Installing the locked dependencies failed" }, async () => {
    await tools.installDependencies(project);
    return { value: undefined, detail: "installed" };
  });
  if (!(await tools.wranglerSignedIn(ctx.exec, i.site.dir))) {
    const signedIn = ctx.interactive && (await ctx.prompt.confirm("wrangler (it builds and uploads the Worker) is not signed in. Open its login?", true)) && (await tools.wranglerLogin(ctx.exec, i.site.dir));
    if (!signedIn) {
      throw new CliError({ code: "AUTH_REQUIRED", message: "wrangler is not signed in to Cloudflare.", hint: "Run `pnpm exec wrangler login`, or set CLOUDFLARE_API_TOKEN (both cf and wrangler use it).", next: ["pnpm exec wrangler login", againCommand(ctx)] });
    }
  }
  await steps.run("Config", { code: "CONFIG_WRITE_FAILED", message: "wrangler.jsonc was not written" }, async () => ({ value: undefined, detail: await writeConfig(i, progress) }));
  const d1 = await steps.run("Resources", { code: "RESOURCE_FAILED", message: "Creating resources failed", hint: "Resources created so far are kept and found again on the next run." }, async () => {
    const r = await createResources(i, progress, (m) => ctx.warn("LIFECYCLE_RULE_NOT_ADDED", m));
    return { value: r.d1, detail: r.detail };
  });
  await steps.run("Build", { code: "BUILD_FAILED", message: "The build failed", hint: "The live site is unchanged." }, async () => {
    await tools.build(project, process.execPath);
    return { value: undefined, detail: "done" };
  });
  return { ...i, d1 };
}

async function finish(ctx: Ctx, steps: Steps, i: Inspection, targets: string[], versionId?: string): Promise<ApplyResult> {
  const db = i.d1.find((d) => d.bindings.includes("DB"))!;
  const recovery = bootstrapState(i.site.dir, i.site.workerName, db.existingId ?? "");
  let token = i.setupToken;
  const secretsCreated = await steps.run("Secrets", { code: "SECRETS_FAILED", message: "The managed secrets were not set" }, async () => {
    const created = await managedSecrets(i, againCommand(ctx), async (value) => {
      token = value;
      if (i.credentials) await recovery.save(value);
    });
    return { value: created, detail: created.length > 0 ? `${plural(created.length, "secret")} created` : "all present" };
  });
  const origin = await resolveOrigin(ctx, i.site, i.api, targets);
  const { initialized, admin } = await steps.run("Site", { code: "ADMIN_FAILED", message: "The site URL or first administrator was not set up" }, async () => {
    const initialized = await initSiteUrl(i.api, db.existingId!, origin);
    const needAdmin = i.credentials !== null && (await usersNow(i.api, db.existingId!)) === 0;
    if (needAdmin) await createFirstAdmin(ctx, i.site, db.existingId!, i.credentials!, origin, token, againCommand(ctx));
    const admin: ApplyResult["admin"] = needAdmin ? "created" : "exists";
    return { value: { initialized, admin }, detail: needAdmin ? "first admin created" : "admin exists" };
  });
  await steps.run("Check", { code: "HTTP_CHECK_FAILED", message: "The login page did not answer", hint: "The new version is live." }, async () => {
    await checkLogin(ctx, origin);
    return { value: undefined, detail: `${origin}/login 200` };
  });
  return { origin, versionId, secretsCreated, admin, siteUrlInitialized: initialized };
}

export async function apply(ctx: Ctx, steps: Steps, i: Inspection, progress: Progress): Promise<ApplyResult> {
  const project: tools.Project = { dir: i.site.dir, configPath: i.site.configPath, accountId: i.account.id, exec: ctx.exec, log: steps.log };
  const ready = await prepare(ctx, steps, project, i, progress);
  const { versionId, targets } = await release(steps, project, ready, progress);
  return finish(ctx, steps, ready, targets, versionId);
}
