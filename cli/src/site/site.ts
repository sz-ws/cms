// What the site declares: read from its directory only (wrangler.jsonc, the core
// version file, extensions/registry.ts). No Cloudflare calls here; comparing
// this with what exists on the account is the commands' job.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { readCoreApiVersion } from "../coreapi.js";
import { CliError } from "../frame/errors.js";
import { getMember, getStringMember, parseJsonc, type JsoncNode } from "../jsonc.js";
import { isPlaceholderId, readWranglerConfig } from "../wrangler-config.js";
import { readPlugins, type PluginInfo } from "./plugins.js";

export interface SiteRoute {
  url: string;
  customDomain: boolean;
}

export interface SiteD1 {
  name: string;
  bindings: string[];
  /** undefined while wrangler.jsonc still has the placeholder id. */
  id: string | undefined;
  migrationsDir: string | undefined;
}

export interface SiteR2 {
  name: string;
  bindings: string[];
}

export interface Site {
  dir: string;
  configPath: string;
  workerName: string;
  accountId: string | undefined;
  workersDev: boolean;
  routes: SiteRoute[];
  d1: SiteD1[];
  r2: SiteR2[];
  /** KV namespace ids still declared (core 2.0 does not use KV). */
  kvIds: string[];
  coreVersion: string | null;
  plugins: PluginInfo[];
}

function routeFrom(node: JsoncNode): SiteRoute | undefined {
  const pattern = node.kind === "string" ? node.value : node.kind === "object" ? getStringMember(node, "pattern") : undefined;
  if (!pattern) return undefined;
  const customMember = node.kind === "object" ? getMember(node, "custom_domain") : undefined;
  const customDomain = customMember?.value.kind === "boolean" && customMember.value.value;
  const host = pattern.replace(/^https?:\/\//, "").replace(/\/\*$/, "").replace(/\*$/, "");
  return { url: `https://${host}`, customDomain };
}

function readRoutes(root: JsoncNode): SiteRoute[] {
  const routes = getMember(root, "routes")?.value;
  const single = getMember(root, "route")?.value;
  const nodes = routes?.kind === "array" ? routes.items : single ? [single] : [];
  return nodes.map(routeFrom).filter((r): r is SiteRoute => r !== undefined);
}

function migrationsDirs(root: JsoncNode): Map<string, string> {
  const out = new Map<string, string>();
  const list = getMember(root, "d1_databases")?.value;
  if (list?.kind !== "array") return out;
  for (const item of list.items) {
    const dir = getStringMember(item, "migrations_dir");
    const name = getStringMember(item, "database_name");
    if (dir && name) out.set(name, dir);
  }
  return out;
}

function groupD1(config: ReturnType<typeof readWranglerConfig>, dirs: Map<string, string>): SiteD1[] {
  const byName = new Map<string, SiteD1>();
  for (const entry of config.d1) {
    const found = byName.get(entry.databaseName);
    const id = isPlaceholderId(entry.currentId) ? undefined : entry.currentId;
    if (found) {
      byName.set(entry.databaseName, { ...found, bindings: [...found.bindings, entry.binding], id: found.id ?? id });
    } else {
      byName.set(entry.databaseName, { name: entry.databaseName, bindings: [entry.binding], id, migrationsDir: dirs.get(entry.databaseName) });
    }
  }
  return [...byName.values()];
}

function groupR2(config: ReturnType<typeof readWranglerConfig>): SiteR2[] {
  const byName = new Map<string, SiteR2>();
  for (const entry of config.r2) {
    const found = byName.get(entry.bucketName);
    byName.set(entry.bucketName, { name: entry.bucketName, bindings: [...(found?.bindings ?? []), entry.binding] });
  }
  return [...byName.values()];
}

export async function readConfigText(configPath: string): Promise<string> {
  try {
    return await readFile(configPath, "utf8");
  } catch {
    throw new CliError({
      code: "CONFIG_MISSING",
      message: `No ${path.basename(configPath)} in ${path.dirname(configPath)}.`,
      hint: "Run this in the site's directory, or point at it with -C <dir>.",
      next: ["cms status -C <site-dir>"],
    });
  }
}

export async function readSite(dir: string, configFile: string): Promise<Site> {
  const configPath = path.resolve(dir, configFile);
  return siteFromText(dir, configPath, await readConfigText(configPath));
}

/** The site as a given wrangler.jsonc text declares it (deploy plans on a renamed copy). */
export async function siteFromText(dir: string, configPath: string, text: string): Promise<Site> {
  let root: JsoncNode;
  let config: ReturnType<typeof readWranglerConfig>;
  try {
    root = parseJsonc(text);
    config = readWranglerConfig(text);
  } catch (e) {
    throw new CliError({ code: "CONFIG_INVALID", message: `${path.basename(configPath)}: ${e instanceof Error ? e.message : String(e)}` });
  }
  if (!config.workerName) {
    throw new CliError({ code: "CONFIG_INVALID", message: `${path.basename(configPath)} has no "name" (the Worker name).` });
  }
  const routes = readRoutes(root);
  const workersDev = getMember(root, "workers_dev")?.value;
  return {
    dir,
    configPath,
    workerName: config.workerName,
    accountId: config.accountId,
    workersDev: workersDev?.kind === "boolean" ? workersDev.value : routes.length === 0,
    routes,
    d1: groupD1(config, migrationsDirs(root)),
    r2: groupR2(config),
    kvIds: config.kv.map((k) => k.currentId).filter((id): id is string => !!id && !isPlaceholderId(id)),
    coreVersion: await readCoreApiVersion(dir),
    plugins: await readPlugins(dir),
  };
}
