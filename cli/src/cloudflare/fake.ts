// An in-memory CloudflarePort for tests: a plain state object in, recorded calls
// out. Nothing here touches a process or the network.

import {
  CloudflareError,
  type AccountReads,
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
  };
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
    account: (id) => reads(port, id),
  };
  return port;
}
