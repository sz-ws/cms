// The checks of `cms doctor`, as pure functions from what was read to
// pass / warn / fail rows. Each failing row says what to run next.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { CF_TESTED, NODE_MIN_MAJOR, nodeTooOld } from "../cloudflare/cf-binary.js";
import type { Readiness } from "../cloudflare/port.js";
import { judge } from "../preflight.js";
import { collectAllSettings } from "../settings.js";
import { readVars } from "../wrangler-config.js";
import { plural } from "./format.js";
import type { StatusData } from "./status-data.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface Check {
  id: string;
  status: CheckStatus;
  title: string;
  detail?: string;
  hint?: string;
  next?: string[];
}

export function nodeCheck(nodeVersion: string): Check {
  return nodeTooOld(nodeVersion)
    ? { id: "node", status: "fail", title: "Node", detail: `${nodeVersion}; cf needs Node ${NODE_MIN_MAJOR} or newer`, hint: "Upgrade Node." }
    : { id: "node", status: "pass", title: "Node", detail: nodeVersion };
}

export function cfCheck(r: Readiness, installCommand: string): Check {
  switch (r.state) {
    case "ready":
      return r.untested
        ? { id: "cf", status: "warn", title: "cf", detail: `${r.version}, newer than the tested ${CF_TESTED}`, hint: `If a command fails, install cf@${CF_TESTED}.` }
        : { id: "cf", status: "pass", title: "cf", detail: r.version };
    case "missing":
      return { id: "cf", status: "fail", title: "cf", detail: "not installed", hint: "cms uses cf (Cloudflare's CLI) to talk to Cloudflare.", next: [installCommand] };
    case "unsupported":
      return { id: "cf", status: "fail", title: "cf", detail: `${r.version} is too old`, next: [installCommand] };
    default:
      return { id: "cf", status: "fail", title: "cf", detail: "cannot run on this Node", hint: "Upgrade Node." };
  }
}

function resourceChecks(data: StatusData): Check[] {
  return data.resources.map((r): Check => {
    const title = `${r.type} ${r.name}`;
    const id = `resource:${r.type}:${r.name}`;
    if (r.type === "worker" && r.state === "missing") {
      return { id, status: "warn", title, detail: "not deployed yet", next: ["cms deploy"] };
    }
    if (r.state === "missing") return { id, status: "fail", title, detail: r.note ?? "missing", next: ["cms deploy"] };
    if (r.state === "unknown") return { id, status: "warn", title, detail: "could not be read", next: ["cms status"] };
    if (r.state === "unused") {
      return { id, status: "warn", title, detail: "not used by 2.0", hint: "Remove kv_namespaces from wrangler.jsonc if it is still there, then delete the namespace in the Cloudflare dashboard." };
    }
    const pending = r.pendingMigrations;
    if (pending && pending.length > 0) {
      return { id, status: "warn", title, detail: `${plural(pending.length, "migration")} pending: ${pending.join(", ")}`, next: ["cms deploy"] };
    }
    return { id, status: "pass", title };
  });
}

function secretChecks(data: StatusData): Check[] {
  const deployed = data.resources.some((r) => r.type === "worker" && r.state === "ok");
  if (!deployed) return [];
  if (data.secrets.names === null) {
    return [{ id: "secrets", status: "warn", title: "Managed secrets", detail: "could not be read", next: ["cms status"] }];
  }
  const missing = data.secrets.managed.filter((m) => m.set === false).map((m) => m.name);
  const notLive = data.secrets.managed.filter((m) => m.set === false && data.secrets.notLive.includes(m.name));
  if (notLive.length > 0) {
    return [{ id: "secrets", status: "fail", title: "Managed secrets", detail: `not on the live version: ${missing.join(", ")}`, hint: "The newest version has them but is not live (an unfinished deploy or a rollback).", next: ["cms deploy"] }];
  }
  return missing.length > 0
    ? [{ id: "secrets", status: "fail", title: "Managed secrets", detail: `missing ${missing.join(", ")}`, hint: "cms deploy creates the missing ones; existing keys are never overwritten.", next: ["cms deploy"] }]
    : [{ id: "secrets", status: "pass", title: "Managed secrets", detail: `${data.secrets.managed.length} of ${data.secrets.managed.length} set` }];
}

export function siteChecks(data: StatusData): Check[] {
  const core: Check = data.site.core
    ? { id: "core", status: "pass", title: "Core", detail: data.site.core }
    : { id: "core", status: "warn", title: "Core", detail: "version not found in src/ext/version.ts" };
  return [core, ...resourceChecks(data), ...secretChecks(data)];
}

/** Plugin settings (preflight.ts judges them), from vars and the Worker's secret names. */
export async function settingsChecks(siteDir: string, configPath: string, secretNames: readonly string[] | null): Promise<Check[]> {
  const { extensions, errors } = await collectAllSettings(path.join(siteDir, "extensions"));
  const vars = readVars(await readFile(configPath, "utf8"));
  const rows = extensions.flatMap((ext) => ext.settings.map((f) => judge(ext.extId, f, vars, secretNames)));
  const checks: Check[] = errors.map((message, i) => ({ id: `settings:error:${i}`, status: "warn", title: "Plugin manifest", detail: message }));
  for (const row of rows) {
    const id = `setting:${row.envKey}`;
    const title = `Setting ${row.envKey}`;
    if (row.verdict === "missing") {
      const next = row.storage === "secret" ? `pnpm exec wrangler secret put ${row.envKey}` : `add "${row.envKey}" to vars in wrangler.jsonc`;
      checks.push({ id, status: "fail", title, detail: `${row.label}: ${row.reason}`, next: [next] });
    } else if (row.verdict === "unverifiable" && row.required) {
      checks.push({ id, status: "warn", title, detail: `${row.label}: ${row.reason}` });
    }
  }
  const ok = rows.filter((r) => r.verdict === "ok").length;
  if (checks.length === 0) {
    checks.push({ id: "settings", status: "pass", title: "Plugin settings", detail: rows.length === 0 ? "no plugin declares settings" : `${ok} of ${rows.length} set` });
  }
  return checks;
}
