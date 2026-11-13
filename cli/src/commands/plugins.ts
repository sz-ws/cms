// `cms plugin list | configure <id> | remove <id>`. (`plugin add` is the 0.x
// installer in cli.ts.) Code plugins live in extensions/ and registry.ts;
// declarative plugins live in the site database and are managed in the admin.

import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { compareVersions } from "../cloudflare/cf-binary.js";
import { CloudflareError } from "../cloudflare/port.js";
import { configureExtension } from "../configure.js";
import type { Ctx, Outcome, PlanItem } from "../frame/context.js";
import { CliError, isCliError } from "../frame/errors.js";
import { nearest } from "../frame/suggest.js";
import { unpatchRegistryContent } from "../patch.js";
import { judge } from "../preflight.js";
import { fetchIndex } from "../registry.js";
import { collectAllSettings } from "../settings.js";
import { readSite, type Site } from "../site/site.js";
import { createReporter, createTtyPrompter, padVisual } from "../ui.js";
import { readVars } from "../wrangler-config.js";
import { againCommand, connect } from "./connect.js";
import { confirmPlan } from "./confirm.js";
import { plural } from "./format.js";

export interface CodePlugin {
  id: string;
  version: string | null;
  /** Newest version in the registry; null when the registry could not be read or does not list it. */
  latest: string | null;
  updateAvailable: boolean | null;
  missingSettings: string[];
  unverifiedSettings: string[];
}

export interface DeclarativePlugin {
  id: string;
  version: string;
  enabled: boolean;
}

/** Secret names and the declarative plugins, when Cloudflare can be read without asking anything. */
async function remote(ctx: Ctx, site: Site): Promise<{ secrets: string[] | null; declarative: DeclarativePlugin[] | null }> {
  try {
    const { port, account } = await connect({ ...ctx, interactive: false }, site.accountId);
    const api = port.account(account.id);
    const secrets = await api.secretNames(site.workerName);
    if (secrets === null) ctx.warn("WORKER_NOT_FOUND", `The Worker ${site.workerName} does not exist yet, so there are no declarative plugins and secret settings are unverified.`);
    const db = site.d1.find((d) => d.bindings.includes("DB"))?.id;
    const rows = db && secrets !== null ? await api.d1Query(db, "SELECT id, version, enabled FROM declarative_extensions ORDER BY id") : null;
    const declarative = rows?.map((r) => ({ id: String(r.id), version: String(r.version), enabled: Number(r.enabled) === 1 })) ?? null;
    return { secrets, declarative };
  } catch (e) {
    if (!isCliError(e) && !(e instanceof CloudflareError)) throw e;
    ctx.warn("REMOTE_UNREAD", `Declarative plugins and secret settings were not read: ${e.message}`);
    return { secrets: null, declarative: null };
  }
}

async function registryVersions(source: string): Promise<Map<string, string> | null> {
  const { entries, errors } = await fetchIndex([{ url: source }]).catch(() => ({ entries: [], errors: [{}] }));
  return errors.length > 0 && entries.length === 0 ? null : new Map(entries.map((e) => [e.id, e.version]));
}

async function settingsState(site: Site, secrets: string[] | null): Promise<Map<string, { missing: string[]; unverified: string[] }>> {
  const { extensions } = await collectAllSettings(path.join(site.dir, "extensions"));
  const vars = readVars(await readFile(site.configPath, "utf8"));
  return new Map(
    extensions.map((ext) => {
      const rows = ext.settings.map((f) => judge(ext.extId, f, vars, secrets));
      return [ext.extId, {
        missing: rows.filter((r) => r.verdict === "missing").map((r) => r.envKey),
        unverified: rows.filter((r) => r.verdict === "unverifiable" && r.required).map((r) => r.envKey),
      }];
    }),
  );
}

function status(p: CodePlugin): string {
  const update = p.latest === null ? "registry: unknown" : p.updateAvailable ? `${p.latest} available` : "up to date";
  const settings = p.missingSettings.length > 0 ? `needs ${plural(p.missingSettings.length, "setting")}` : p.unverifiedSettings.length > 0 ? `${p.unverifiedSettings.length} unverified` : "";
  return [update, settings].filter(Boolean).join(" · ");
}

export function renderPlugins(code: readonly CodePlugin[], declarative: readonly DeclarativePlugin[] | null): string {
  const width = Math.max(10, ...code.map((p) => p.id.length), ...(declarative ?? []).map((p) => p.id.length)) + 3;
  return [
    "Code plugins (compiled in, extensions/)",
    ...(code.length > 0 ? code.map((p) => `  ${padVisual(p.id, width)}${padVisual(p.version ?? "?", 10)}${status(p)}`.trimEnd()) : ["  none"]),
    "",
    "Declarative plugins (managed in the admin)",
    ...(declarative === null ? ["  not read (see the warning)"] : declarative.length > 0 ? declarative.map((p) => `  ${padVisual(p.id, width)}${padVisual(p.version, 10)}${p.enabled ? "enabled" : "disabled"}`) : ["  none"]),
  ].join("\n");
}

export async function runPluginList(ctx: Ctx): Promise<Outcome> {
  const site = await readSite(ctx.cwd, String(ctx.values.config));
  const [{ secrets, declarative }, registry] = await ctx.progress("Reading plugins", () => Promise.all([remote(ctx, site), registryVersions(String(ctx.values.source))]));
  if (registry === null) ctx.warn("REGISTRY_UNREAD", `The registry at ${String(ctx.values.source)} could not be read; whether updates exist is unknown.`);
  const settings = await settingsState(site, secrets);
  const code: CodePlugin[] = site.plugins.map((p) => {
    const latest = registry?.get(p.id) ?? null;
    const s = settings.get(p.id) ?? { missing: [], unverified: [] };
    return {
      id: p.id,
      version: p.version ?? null,
      latest,
      updateAvailable: latest && p.version ? compareVersions(latest, p.version) > 0 : null,
      missingSettings: s.missing,
      unverifiedSettings: s.unverified,
    };
  });
  return { data: { code, declarative }, text: renderPlugins(code, declarative) };
}

/** Installed code plugin ids: directories under extensions/ (the registry's own file is not one). */
async function installedIds(site: Site): Promise<string[]> {
  const dir = path.join(site.dir, "extensions");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function installedId(ctx: Ctx, site: Site): Promise<string> {
  const id = ctx.positionals[0] ?? "";
  const ids = await installedIds(site);
  if (ids.includes(id)) return id;
  const suggestion = nearest(id, ids);
  throw new CliError({
    code: "PLUGIN_NOT_FOUND",
    message: `No plugin "${id}" in extensions/.`,
    hint: suggestion ? `Did you mean ${suggestion}?` : `Installed: ${ids.join(", ") || "none"}.`,
    next: suggestion ? [`cms ${ctx.spec.name} ${suggestion}`, "cms plugin list"] : ["cms plugin list"],
  });
}

export async function runPluginConfigure(ctx: Ctx): Promise<Outcome> {
  const site = await readSite(ctx.cwd, String(ctx.values.config));
  const id = await installedId(ctx, site);
  if (!ctx.interactive) {
    const missing = (await settingsState(site, null)).get(id)?.missing ?? [];
    if (missing.length > 0) {
      throw new CliError({
        code: "INPUT_REQUIRED",
        message: `${id} has required settings that are empty: ${missing.join(", ")}.`,
        hint: "Run this in a terminal to answer them, or set them yourself: values in vars of wrangler.jsonc, secrets with cms secret set.",
        next: [againCommand(ctx)],
        data: { missing: missing.map((env) => ({ input: env, env })) },
      });
    }
    return { data: { id, missing: [] }, text: `${id}: no required setting is empty in wrangler.jsonc.` };
  }
  const result = await configureExtension({
    extensionsDir: path.join(site.dir, "extensions"),
    configPath: site.configPath,
    devVarsPath: path.join(site.dir, ".dev.vars"),
    extId: id,
    reporter: createReporter({ write: ctx.io.err, animate: false, styles: ctx.err }),
    prompter: createTtyPrompter(),
    interactive: true,
  });
  if (result === null) return { data: { id, settings: 0 }, text: `${id} declares no settings.` };
  return {
    data: { id, ...result },
    text: [
      `${id}: ${plural(result.varsWritten.length, "value")} written to wrangler.jsonc.`,
      ...result.secretCommands.map((c) => `secret: ${c}`),
      ...(result.unanswered.length > 0 ? [`still empty: ${result.unanswered.join(", ")}`] : []),
    ].join("\n"),
  };
}

async function filesOf(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((e) => (e.isDirectory() ? filesOf(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))])));
  return nested.flat().sort();
}

export async function runPluginRemove(ctx: Ctx): Promise<Outcome> {
  const site = await readSite(ctx.cwd, String(ctx.values.config));
  const id = await installedId(ctx, site);
  const dir = path.join(site.dir, "extensions", id);
  const registryPath = path.join(site.dir, "extensions", "registry.ts");
  const registry = existsSync(registryPath) ? await readFile(registryPath, "utf8") : "";
  const unpatched = unpatchRegistryContent(registry, id);
  const files = (await filesOf(dir)).map((f) => `extensions/${id}/${f}`);
  const plan: PlanItem[] = [
    ...files.map((name) => ({ action: "delete", type: "file", name })),
    ...(unpatched.importRemoved || unpatched.arrayRemoved ? [{ action: "write", type: "file", name: "extensions/registry.ts" }] : []),
  ];
  ctx.warn("DATA_KEPT", `${id}'s tables and data stay in the database, and its settings stay in wrangler.jsonc and on the Worker.`);
  ctx.warn("NEEDS_DEPLOY", `The live site keeps ${id} until the next cms deploy.`);
  const lines = ["   Plan", ...plan.map((p) => `   ${p.action === "delete" ? "-" : "~"} ${p.name}`)];
  if (ctx.values["dry-run"] === true) return { data: { id, files, dryRun: true }, plan, text: [...lines, "", "   Dry run: nothing was changed."].join("\n") };
  if (!ctx.json) ctx.say(["", ...lines, ""].join("\n"));
  await confirmPlan(ctx, plan, `Remove ${id}?`);
  await rm(dir, { recursive: true, force: true });
  if (unpatched.content !== registry) await writeFile(registryPath, unpatched.content, "utf8");
  return { data: { id, files }, plan, text: `Removed ${id} (${plural(files.length, "file")}). It leaves the live site at the next cms deploy.\nnext: cms deploy --dry-run` };
}

