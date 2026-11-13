// The one interface the CLI uses to talk to Cloudflare.
//
// Phase 1 implements it on Cloudflare's own `cf` CLI (cf-port.ts) and on a fake
// for tests (fake.ts). Nothing outside this folder knows a cf command line, so a
// later REST implementation is a drop-in.

export type AuthKind = "api-token" | "oauth" | "other";

export interface AuthSource {
  kind: AuthKind;
  /** Human wording, e.g. "API token from CLOUDFLARE_API_TOKEN". Never a path or a token. */
  label: string;
  /** cf auth profile, when it is not the default one. */
  profile?: string;
}

export interface AccountRef {
  id: string;
  name: string;
}

export interface Identity {
  authenticated: boolean;
  source?: AuthSource;
  email?: string;
  accounts: AccountRef[];
}

export type Readiness =
  | { state: "ready"; version: string; command: string; untested: boolean }
  | { state: "missing" }
  | { state: "node-too-old"; node: string }
  | { state: "unsupported"; version: string; command: string };

export interface InstallPlan {
  /** What to show the user, e.g. "pnpm add -D cf@1.0.0-beta.32". */
  display: string;
  cmd: string;
  args: string[];
}

export interface WorkerInfo {
  name: string;
  /** workers.dev URL when the subdomain is enabled. */
  workersDevUrl?: string;
  deployedOn?: string;
}

export interface Deployment {
  id: string;
  createdOn: string;
  versions: { versionId: string; percentage: number }[];
}

export interface WorkerVersion {
  id: string;
  number?: number;
  createdOn: string;
  source?: string;
  message?: string;
  tag?: string;
}

export interface D1Info {
  id: string;
  name: string;
}

export interface KvNamespace {
  id: string;
  title: string;
}

/** Reads scoped to one account. All read-only. */
export interface AccountReads {
  /** null when the Worker does not exist. */
  worker(name: string): Promise<WorkerInfo | null>;
  /** Newest first; null when the Worker does not exist. */
  deployments(worker: string, limit: number): Promise<Deployment[] | null>;
  /** Newest first; null when the Worker does not exist. */
  versions(worker: string, limit: number): Promise<WorkerVersion[] | null>;
  d1List(): Promise<D1Info[]>;
  /** Migration file names not yet applied to the database. */
  d1PendingMigrations(databaseId: string, dir: string): Promise<string[]>;
  r2Exists(bucket: string): Promise<boolean>;
  kvList(): Promise<KvNamespace[]>;
  /** Secret names only; null when the Worker does not exist. */
  secretNames(worker: string): Promise<string[] | null>;
}

export interface CloudflarePort {
  readiness(): Promise<Readiness>;
  installPlan(): InstallPlan;
  /** Install cf into the site project; the child gets the terminal. */
  install(): Promise<boolean>;
  /** Run cf's browser login; the child gets the terminal. */
  login(): Promise<boolean>;
  whoami(): Promise<Identity>;
  account(id: string): AccountReads;
}

/** Why a remote call failed. Mapped to CliError codes by the caller-facing layer. */
export type CloudflareFailure =
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "TRANSIENT"
  | "FAILED";

export class CloudflareError extends Error {
  readonly failure: CloudflareFailure;
  readonly apiCode: number | undefined;
  readonly status: number | undefined;

  constructor(failure: CloudflareFailure, message: string, apiCode?: number, status?: number) {
    super(message);
    this.name = "CloudflareError";
    this.failure = failure;
    this.apiCode = apiCode;
    this.status = status;
  }
}
