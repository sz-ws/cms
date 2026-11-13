// An in-memory CloudflarePort for tests: a plain state object in, recorded calls
// out. Nothing here touches a process or the network.

import {
  CloudflareError,
  type AccountApi,
  type AccountReads,
  type AccountWrites,
  type LifecycleRule,
  type LogEvent,
  type CloudflarePort,
  type D1Info,
  type Deployment,
  type Identity,
  type InstallPlan,
  type KvNamespace,
  type Readiness,
  type WorkerInfo,
  type WorkerVersion,
} from "./port.js";

export interface FakeWorker extends WorkerInfo {
  deployments: Deployment[];
  versions: WorkerVersion[];
  secrets: string[];
}

export interface FakeCloudflare {
  readiness: Readiness;
  /** What readiness becomes after install() (default: ready). */
  afterInstall?: Readiness;
  installSucceeds?: boolean;
  /** Thrown by install() (e.g. the package manager is missing). */
  installError?: Error;
  identity: Identity;
  /** Identity after login() (default: unchanged). */
  afterLogin?: Identity;
  loginSucceeds?: boolean;
  workers: Record<string, FakeWorker>;
  d1: D1Info[];
  /** Pending migration names per database id. */
  pending: Record<string, string[]>;
  r2: string[];
  kv: KvNamespace[];
  /** Throw this from every account read (e.g. a transient error). */
  failReads?: CloudflareError;
  /** Lifecycle rules per bucket. */
  lifecycle?: Record<string, LifecycleRule[]>;
  /** Answers d1Query: rows for a database id and SQL (default: no rows). */
  query?: (databaseId: string, sql: string) => Record<string, unknown>[];
  /** Buckets that hold objects. */
  nonEmpty?: string[];
  /** Answers recentErrors. */
  logs?: LogEvent[];
  /** Throw this from the write whose call text starts with the key (e.g. "promote"). */
  failWrites?: Record<string, CloudflareError>;
}

export interface FakePort extends CloudflarePort {
  calls: string[];
  state: FakeCloudflare;
}

export function fakeCloudflare(overrides: Partial<FakeCloudflare> = {}): FakeCloudflare {
  return {
    readiness: { state: "ready", version: "1.0.0-beta.32", command: "cf", untested: false },
    identity: {
      authenticated: true,
      source: { kind: "oauth", label: "signed in through cf" },
      email: "you@example.com",
      accounts: [{ id: "acc1", name: "Acme Studio" }],
    },
    workers: {},
    d1: [],
    pending: {},
    r2: [],
    kv: [],
    ...overrides,
  };
}

function reads(port: FakePort, accountId: string): AccountReads {
  const s = port.state;
  const read = async <T>(call: string, fn: () => T): Promise<T> => {
    port.calls.push(`${call} @${accountId}`);
    if (s.failReads) throw s.failReads;
    return fn();
  };
  const worker = (name: string) => s.workers[name];
  return {
    worker: (name) => read(`worker ${name}`, () => (worker(name) ? { ...worker(name) } : null)),
    deployments: (name, limit) => read(`deployments ${name}`, () => worker(name)?.deployments.slice(0, limit) ?? null),
    versions: (name, limit) => read(`versions ${name}`, () => worker(name)?.versions.slice(0, limit) ?? null),
    d1List: () => read("d1List", () => [...s.d1]),
    d1PendingMigrations: (id, dir) => read(`pending ${id} ${dir}`, () => [...(s.pending[id] ?? [])]),
    r2Exists: (bucket) => read(`r2 ${bucket}`, () => s.r2.includes(bucket)),
    kvList: () => read("kvList", () => [...s.kv]),
    secretNames: (name) => read(`secrets ${name}`, () => (worker(name) ? [...worker(name).secrets] : null)),
    r2LifecycleRules: (bucket) => read(`lifecycle ${bucket}`, () => [...(s.lifecycle?.[bucket] ?? [])]),
    d1Query: (id, sql) => read(`query ${id} ${sql}`, () => s.query?.(id, sql) ?? []),
    r2HasObjects: (bucket) => read(`objects ${bucket}`, () => (s.nonEmpty ?? []).includes(bucket)),
    recentErrors: (name, from, to, limit) => read(`logs ${name} ${to - from} ${limit}`, () => (s.logs ?? []).slice(0, limit)),
  };
}

/** Writes change the fake state, so a test can read what a deploy left behind. */
function writes(port: FakePort, accountId: string): AccountWrites {
  const s = port.state;
  const write = async <T>(call: string, fn: () => T): Promise<T> => {
    port.calls.push(`${call} @${accountId}`);
    const failure = Object.entries(s.failWrites ?? {}).find(([key]) => call.startsWith(key))?.[1];
    if (failure) throw failure;
    return fn();
  };
  return {
    d1Create: (name) =>
      write(`d1Create ${name}`, () => {
        const db = { id: `id-${name}`, name };
        s.d1.push(db);
        return db;
      }),
    r2Create: (name) => write(`r2Create ${name}`, () => void s.r2.push(name)),
    r2SetLifecycleRules: (bucket, rules) =>
      write(`r2SetLifecycleRules ${bucket} ${rules.map((r) => r.id).join(",")}`, () => {
        s.lifecycle = { ...s.lifecycle, [bucket]: [...rules] };
      }),
    putSecret: (worker, name) =>
      write(`putSecret ${worker} ${name}`, () => void s.workers[worker]?.secrets.push(name)),
    promote: (worker, versionId) => write(`promote ${worker} ${versionId}`, () => undefined),
    deleteSecret: (worker, name) =>
      write(`deleteSecret ${worker} ${name}`, () => {
        const w = s.workers[worker];
        if (w) w.secrets = w.secrets.filter((n) => n !== name);
      }),
    deleteWorker: (worker) =>
      write(`deleteWorker ${worker}`, () => {
        s.workers = Object.fromEntries(Object.entries(s.workers).filter(([k]) => k !== worker));
      }),
    d1Delete: (id) => write(`d1Delete ${id}`, () => void (s.d1 = s.d1.filter((d) => d.id !== id))),
    r2Delete: (bucket) => write(`r2Delete ${bucket}`, () => void (s.r2 = s.r2.filter((b) => b !== bucket))),
    kvDelete: (id) => write(`kvDelete ${id}`, () => void (s.kv = s.kv.filter((n) => n.id !== id))),
  };
}

function api(port: FakePort, accountId: string): AccountApi {
  return { ...reads(port, accountId), ...writes(port, accountId) };
}

export function createFakePort(state: FakeCloudflare): FakePort {
  const plan: InstallPlan = { display: "pnpm add -D cf@1.0.0-beta.32", cmd: "pnpm", args: ["add", "-D", "cf@1.0.0-beta.32"] };
  const port: FakePort = {
    calls: [],
    state,
    readiness: async () => state.readiness,
    installPlan: () => plan,
    install: async () => {
      port.calls.push("install");
      if (state.installError) throw state.installError;
      if (state.installSucceeds === false) return false;
      state.readiness = state.afterInstall ?? { state: "ready", version: "1.0.0-beta.32", command: "cf", untested: false };
      return true;
    },
    login: async () => {
      port.calls.push("login");
      if (state.loginSucceeds === false) return false;
      if (state.afterLogin) state.identity = state.afterLogin;
      return true;
    },
    whoami: async () => {
      port.calls.push("whoami");
      return state.identity;
    },
    account: (id) => api(port, id),
  };
  return port;
}
