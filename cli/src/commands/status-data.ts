// `cms status` data: what the site declares compared with what exists on the
// account. Shared with `cms doctor`, which turns the same data into checks.

import path from "node:path";
import type { AccountReads, Deployment, KvNamespace, WorkerInfo } from "../cloudflare/port.js";
import { CloudflareError } from "../cloudflare/port.js";
import type { Ctx } from "../frame/context.js";
import { MANAGED_SECRETS } from "../secrets.js";
import type { Site } from "../site/site.js";
import type { ChosenAccount } from "./connect.js";

export type ResourceState = "ok" | "missing" | "unused" | "unknown";

export interface ResourceRow {
  type: "worker" | "d1" | "r2" | "kv";
  name: string;
  state: ResourceState;
  bindings?: string[];
  id?: string;
  /** D1 with migrations_dir: files not yet applied; null when unknown. */
  pendingMigrations?: string[] | null;
  note?: string;
}

export interface StatusData {
  site: { worker: string; core: string | null; config: string };
  account: { id: string; name: string; from: string };
  auth: { kind: string; label: string; profile?: string };
  cf: { version: string };
  live: { versionId: string; deployedAt: string; versions: { versionId: string; percentage: number }[] } | null;
  urls: string[];
  resources: ResourceRow[];
  /** Names only; values are never read. names is null when they could not be read. */
  secrets: { names: string[] | null; managed: { name: string; set: boolean | null }[] };
  plugins: { id: string; version: string | null }[];
}

/** A read whose failure should leave a gap in the report, not end it. */
async function tolerant<T>(ctx: Ctx, what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CloudflareError && (e.failure === "TRANSIENT" || e.failure === "FAILED")) {
      ctx.warn("READ_FAILED", `Could not read ${what}: ${e.message}`);
      return undefined;
    }
    throw e;
  }
}

interface RemoteReads {
  worker: WorkerInfo | null | undefined;
  deployments: Deployment[] | null | undefined;
  d1: Map<string, string> | undefined;
  r2: Map<string, boolean | undefined>;
  kv: KvNamespace[] | undefined;
  secrets: string[] | null | undefined;
}

async function readRemote(ctx: Ctx, site: Site, reads: AccountReads): Promise<RemoteReads> {
  const w = site.workerName;
  const [worker, deployments, d1, kv, secrets, ...r2] = await Promise.all([
    tolerant(ctx, `the Worker ${w}`, () => reads.worker(w)),
    tolerant(ctx, "deployments", () => reads.deployments(w, 1)),
    tolerant(ctx, "D1 databases", async () => new Map((await reads.d1List()).map((d) => [d.id, d.name]))),
    tolerant(ctx, "KV namespaces", () => reads.kvList()),
    tolerant(ctx, "the Worker's secret names", () => reads.secretNames(w)),
    ...site.r2.map((b) => tolerant(ctx, `R2 bucket ${b.name}`, () => reads.r2Exists(b.name))),
  ]);
  return { worker, deployments, d1, kv, secrets, r2: new Map(site.r2.map((b, i) => [b.name, r2[i]])) };
}

function workerRow(site: Site, remote: RemoteReads): ResourceRow {
  const state = remote.worker === undefined ? "unknown" : remote.worker ? "ok" : "missing";
  return { type: "worker", name: site.workerName, state, ...(state === "missing" ? { note: "not deployed yet" } : {}) };
}

async function d1Rows(ctx: Ctx, site: Site, reads: AccountReads, remote: RemoteReads): Promise<ResourceRow[]> {
  return Promise.all(
    site.d1.map(async (db): Promise<ResourceRow> => {
      const base = { type: "d1" as const, name: db.name, bindings: db.bindings, ...(db.id ? { id: db.id } : {}) };
      if (!db.id) return { ...base, state: "missing", note: "no database_id in wrangler.jsonc" };
      if (remote.d1 === undefined) return { ...base, state: "unknown" };
      if (!remote.d1.has(db.id)) return { ...base, state: "missing", note: "database_id not found on this account" };
      if (!db.migrationsDir) return { ...base, state: "ok" };
      const dir = db.migrationsDir;
      const pending = await tolerant(ctx, `pending migrations of ${db.name}`, () => reads.d1PendingMigrations(db.id!, dir));
      return { ...base, state: "ok", pendingMigrations: pending ?? null };
    }),
  );
}

function r2Rows(site: Site, remote: RemoteReads): ResourceRow[] {
  return site.r2.map((b) => {
    const exists = remote.r2.get(b.name);
    return { type: "r2", name: b.name, bindings: b.bindings, state: exists === undefined ? "unknown" : exists ? "ok" : "missing" };
  });
}

/** KV left over from 1.x: the namespace named after the Worker, or ids still in wrangler.jsonc. */
function kvRows(site: Site, remote: RemoteReads): ResourceRow[] {
  const leftover = (remote.kv ?? []).filter((n) => n.title === `${site.workerName}-kv` || site.kvIds.includes(n.id));
  return leftover.map((n) => ({ type: "kv", name: n.title, id: n.id, state: "unused", note: "not used by 2.0, safe to delete" }));
}

function urlsOf(site: Site, worker: WorkerInfo | null | undefined): string[] {
  const routes = site.routes.map((r) => r.url);
  const dev = site.workersDev && worker?.workersDevUrl ? [worker.workersDevUrl] : [];
  return [...new Set([...routes, ...dev])];
}

function liveOf(deployments: Deployment[] | null | undefined): StatusData["live"] {
  const latest = deployments?.[0];
  if (!latest) return null;
  const main = [...latest.versions].sort((a, b) => b.percentage - a.percentage)[0];
  return { versionId: main?.versionId ?? "", deployedAt: latest.createdOn, versions: latest.versions };
}

export interface StatusInput {
  site: Site;
  reads: AccountReads;
  account: ChosenAccount;
  auth: StatusData["auth"];
  cfVersion: string;
}

export async function gatherStatus(ctx: Ctx, input: StatusInput): Promise<StatusData> {
  const { site, reads } = input;
  const remote = await readRemote(ctx, site, reads);
  const resources = [workerRow(site, remote), ...(await d1Rows(ctx, site, reads, remote)), ...r2Rows(site, remote), ...kvRows(site, remote)];
  const secrets = remote.secrets;
  return {
    site: { worker: site.workerName, core: site.coreVersion, config: path.relative(site.dir, site.configPath) },
    account: { id: input.account.id, name: input.account.name, from: input.account.from },
    auth: input.auth,
    cf: { version: input.cfVersion },
    live: liveOf(remote.deployments),
    urls: urlsOf(site, remote.worker),
    resources,
    secrets: {
      names: secrets ?? null,
      managed: MANAGED_SECRETS.map((m) => ({ name: m.name, set: secrets === undefined || secrets === null ? null : secrets.includes(m.name) })),
    },
    plugins: site.plugins.map((p) => ({ id: p.id, version: p.version ?? null })),
  };
}
