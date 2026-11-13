// CloudflarePort on top of Cloudflare's `cf` CLI: one child process per call,
// JSON read from stdout, failures classified from stderr, one retry policy.
//
// cf commands used. Reads:
//   cf --version
//   cf auth whoami
//   cf auth login                                   (terminal handed to cf)
//   cf workers get <worker>
//   cf workers deployments list --worker <w> --per-page <n>
//   cf workers versions list --worker <w> --per-page <n>
//   cf workers secrets list --worker <w>
//   cf d1 list --per-page 100
//   cf d1 migrations list <database-id> --dir <dir>
//   cf r2 buckets list --name-contains <bucket>
//   cf kv namespaces list --per-page 100
//   cf r2 buckets lifecycle get <bucket>
//   cf d1 query <database-id> --sql <sql>              (also the two writes deploy makes)
// Writes (only `cms deploy` and `cms secrets`):
//   cf auth login                                      (terminal handed to cf)
//   cf d1 create --name <name>
//   cf r2 buckets create --name <name>
//   cf r2 buckets lifecycle update <bucket> --rules @<file> -f
//   cf workers secrets update <name> --worker <w> --body @<file>   (0600 file, deleted after)
//   cf workers deployments create --worker <w> --strategy percentage --versions <json>
// The account goes in CLOUDFLARE_ACCOUNT_ID (cf has no account flag). Creates are
// not retried: a create that reached Cloudflare and then lost its answer would
// otherwise fail as "already exists" on the second try.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isProgramMissing, type Executor } from "../exec.js";
import { findCf, installPlanFor } from "./cf-binary.js";
import { failureFrom, firstJsonValue } from "./cf-output.js";
import {
  CloudflareError,
  type AccountApi,
  type AccountReads,
  type AccountWrites,
  type LifecycleRule,
  type AuthSource,
  type CloudflarePort,
  type Deployment,
  type Identity,
  type Readiness,
  type WorkerVersion,
} from "./port.js";
import { withRetry, type Sleep } from "./retry.js";

export interface CfPortOptions {
  exec: Executor;
  /** The site directory: cf is looked up and run from here. */
  cwd: string;
  nodeVersion: string;
  sleep?: Sleep;
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function authSourceFrom(raw: unknown, profile: unknown): AuthSource {
  const text = str(raw) ?? "";
  const name = str(asRecord(profile).name);
  const named = name && name !== "default" ? { profile: name } : {};
  if (/CLOUDFLARE_API_TOKEN/.test(text)) return { kind: "api-token", label: "API token from CLOUDFLARE_API_TOKEN", ...named };
  if (/^OAuth/i.test(text)) return { kind: "oauth", label: "signed in through cf", ...named };
  // Anything else is reported by kind only: cf's text may contain a file path.
  return { kind: "other", label: "cf credentials", ...named };
}

export function identityFrom(value: unknown): Identity {
  const o = asRecord(value);
  const accounts = asArray(o.accounts)
    .map(asRecord)
    .map((a) => ({ id: str(a.id) ?? "", name: str(a.name) ?? "" }))
    .filter((a) => a.id !== "");
  if (o.authenticated !== true || o.tokenValid === false) return { authenticated: false, accounts: [] };
  return { authenticated: true, source: authSourceFrom(o.authSource, o.profile), email: str(o.email), accounts };
}

export function deploymentsFrom(value: unknown): Deployment[] {
  return asArray(asRecord(value).deployments).map((raw) => {
    const d = asRecord(raw);
    return {
      id: str(d.id) ?? "",
      createdOn: str(d.created_on) ?? "",
      versions: asArray(d.versions).map((v) => ({
        versionId: str(asRecord(v).version_id) ?? "",
        percentage: Number(asRecord(v).percentage ?? 0),
      })),
    };
  });
}

export function versionsFrom(value: unknown): WorkerVersion[] {
  return asArray(value).map((raw) => {
    const v = asRecord(raw);
    const notes = asRecord(v.annotations);
    return {
      id: str(v.id) ?? "",
      number: typeof v.number === "number" ? v.number : undefined,
      createdOn: str(v.created_on) ?? "",
      source: str(v.source),
      message: str(notes["workers/message"]),
      tag: str(notes["workers/tag"]),
    };
  });
}

class CfRunner {
  constructor(
    private readonly o: CfPortOptions,
    private readonly command: () => Promise<string>,
  ) {}

  /** Run a command and return its JSON. Transient failures are retried unless `once`. */
  async json(args: readonly string[], accountId?: string, opts: { once?: boolean; optionalJson?: boolean } = {}): Promise<unknown> {
    const cmd = await this.command();
    const env: Record<string, string> = { CF_QUIET: "1", NO_COLOR: "1", ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}) };
    const attempt = async () => {
      const r = await this.o.exec(cmd, args, { cwd: this.o.cwd, env }).catch((e: unknown) => {
        if (isProgramMissing(e)) throw e;
        throw new CloudflareError("TRANSIENT", e instanceof Error ? e.message : String(e));
      });
      if (r.code !== 0) throw failureFrom(r.stderr, r.code);
      const value = firstJsonValue(r.stdout);
      if (value === undefined && !opts.optionalJson) throw new CloudflareError("FAILED", `cf ${args.slice(0, 3).join(" ")} printed no JSON`);
      return value;
    };
    return opts.once ? attempt() : withRetry(attempt, this.o.sleep);
  }

  /** Run with the terminal handed over; only the exit code is known. */
  async interactive(cmd: string, args: readonly string[]): Promise<boolean> {
    const r = await this.o.exec(cmd, args, { cwd: this.o.cwd, inheritStdio: true });
    return r.code === 0;
  }
}

async function orNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CloudflareError && e.failure === "NOT_FOUND") return null;
    throw e;
  }
}

function accountReads(run: CfRunner, accountId: string): AccountReads {
  const get = (args: readonly string[]) => run.json(args, accountId);
  return {
    worker: (name) =>
      orNull(async () => {
        const w = asRecord(await get(["workers", "get", name]));
        const sub = asRecord(w.subdomain);
        return {
          name: str(w.name) ?? name,
          workersDevUrl: sub.enabled === true ? str(sub.url) : undefined,
          deployedOn: str(w.deployed_on),
        };
      }),
    deployments: (worker, limit) =>
      orNull(async () => deploymentsFrom(await get(["workers", "deployments", "list", "--worker", worker, "--per-page", String(limit)]))),
    versions: (worker, limit) =>
      orNull(async () => versionsFrom(await get(["workers", "versions", "list", "--worker", worker, "--per-page", String(limit)]))),
    d1List: async () =>
      asArray(await get(["d1", "list", "--per-page", "100"]))
        .map(asRecord)
        .map((d) => ({ id: str(d.uuid) ?? "", name: str(d.name) ?? "" })),
    d1PendingMigrations: async (databaseId, dir) =>
      asArray(await get(["d1", "migrations", "list", databaseId, "--dir", dir]))
        .map((m) => str(asRecord(m).Name) ?? str(asRecord(m).name) ?? "")
        .filter((n) => n !== ""),
    r2Exists: async (bucket) =>
      asArray(asRecord(await get(["r2", "buckets", "list", "--name-contains", bucket])).buckets).some(
        (b) => asRecord(b).name === bucket,
      ),
    kvList: async () =>
      asArray(await get(["kv", "namespaces", "list", "--per-page", "100"]))
        .map(asRecord)
        .map((n) => ({ id: str(n.id) ?? "", title: str(n.title) ?? "" })),
    secretNames: (worker) =>
      orNull(async () =>
        asArray(await get(["workers", "secrets", "list", "--worker", worker]))
          .map((s) => str(asRecord(s).name) ?? "")
          .filter((n) => n !== ""),
      ),
    r2LifecycleRules: async (bucket) =>
      asArray(asRecord(await get(["r2", "buckets", "lifecycle", "get", bucket])).rules).map(
        (r) => asRecord(r) as LifecycleRule,
      ),
    d1Query: async (databaseId, sql) =>
      asArray(asRecord(asArray(await get(["d1", "query", databaseId, "--sql", sql]))[0]).results).map(asRecord),
  };
}

/** A private temp file for a request body, removed after the call. */
async function withBodyFile<T>(content: unknown, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "cms-cf-"));
  const file = path.join(dir, "body.json");
  try {
    await writeFile(file, JSON.stringify(content), { mode: 0o600 });
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function accountWrites(run: CfRunner, accountId: string): AccountWrites {
  const send = (args: readonly string[], once = false) => run.json(args, accountId, { once, optionalJson: true });
  return {
    d1Create: async (name) => {
      const d = asRecord(await run.json(["d1", "create", "--name", name], accountId, { once: true }));
      const id = str(d.uuid) ?? str(d.id);
      if (!id) throw new CloudflareError("FAILED", `cf d1 create did not return the id of ${name}`);
      return { id, name };
    },
    r2Create: async (name) => void (await send(["r2", "buckets", "create", "--name", name], true)),
    r2SetLifecycleRules: (bucket, rules) =>
      withBodyFile(rules, async (file) => void (await send(["r2", "buckets", "lifecycle", "update", bucket, "--rules", `@${file}`, "-f"]))),
    putSecret: (worker, name, value) =>
      withBodyFile({ name, type: "secret_text", text: value }, async (file) =>
        void (await send(["workers", "secrets", "update", name, "--worker", worker, "--body", `@${file}`])),
      ),
    promote: async (worker, versionId) =>
      void (await send([
        "workers", "deployments", "create", "--worker", worker, "--strategy", "percentage",
        "--versions", JSON.stringify([{ version_id: versionId, percentage: 100 }]),
      ])),
  };
}

function accountApi(run: CfRunner, accountId: string): AccountApi {
  return { ...accountReads(run, accountId), ...accountWrites(run, accountId) };
}

export function createCfPort(o: CfPortOptions): CloudflarePort {
  let readiness: Promise<Readiness> | undefined;
  const check = () => (readiness ??= findCf(o.exec, o.cwd, o.nodeVersion));
  const command = async () => {
    const r = await check();
    if (r.state !== "ready") throw new CloudflareError("FAILED", "cf is not ready");
    return r.command;
  };
  const run = new CfRunner(o, command);
  return {
    readiness: check,
    installPlan: () => installPlanFor(o.cwd),
    install: async () => {
      const plan = installPlanFor(o.cwd);
      const ok = await run.interactive(plan.cmd, plan.args);
      readiness = undefined; // look again: it is installed now, or still missing
      return ok;
    },
    login: async () => run.interactive(await command(), ["auth", "login"]),
    whoami: async () => {
      try {
        return identityFrom(await run.json(["auth", "whoami"]));
      } catch (e) {
        if (e instanceof CloudflareError && e.failure === "AUTH_REQUIRED") return { authenticated: false, accounts: [] };
        throw e;
      }
    },
    account: (id) => accountApi(run, id),
  };
}
