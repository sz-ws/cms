import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePort, fakeCloudflare, type FakeCloudflare, type FakePort } from "../../cloudflare/fake.js";
import { ProgramMissingError, type ExecOptions, type ExecResult, type Executor } from "../../exec.js";
import type { Deps, Io } from "../../frame/context.js";
import { cancelled } from "../../frame/errors.js";
import type { Prompt } from "../../frame/prompt.js";
import { runNew } from "../router.js";
import { newestReleaseTag } from "../init.js";

const TEMPLATE = (names: { worker: string; slug: string; db: string; storage: string; cache: string; id?: string }) => `{
  // comments stay
  "$schema": "node_modules/wrangler/config-schema.json",
  "main": "custom-worker.ts",
  "name": "${names.worker}",
  "services": [{ "binding": "WORKER_SELF_REFERENCE", "service": "${names.worker}" }],
  "vars": { "CMS_SITE_SLUG": "${names.slug}" },
  "d1_databases": [
    { "binding": "DB", "database_name": "${names.db}", "database_id": "${names.id ?? "00000000-0000-0000-0000-000000000000"}", "migrations_dir": "migrations" },
    { "binding": "NEXT_TAG_CACHE_D1", "database_name": "${names.db}", "database_id": "${names.id ?? "00000000-0000-0000-0000-000000000000"}" }
  ],
  "r2_buckets": [
    { "binding": "STORAGE", "bucket_name": "${names.storage}" },
    { "binding": "NEXT_INC_CACHE_R2_BUCKET", "bucket_name": "${names.cache}" }
  ]
}
`;
const FRESH = TEMPLATE({ worker: "cms", slug: "", db: "cms-db", storage: "cms-storage", cache: "cms-next-cache" });
const ACCOUNT_LINE = `  "account_id": "0123456789abcdef0123456789abcdef",\n`;
const ACME_NO_ACCOUNT = TEMPLATE({ worker: "cms-acme", slug: "acme", db: "cms-acme-db", storage: "cms-acme-storage", cache: "cms-acme-next-cache", id: "db-1" });
const ACME = ACME_NO_ACCOUNT.replace('  "main"', `${ACCOUNT_LINE}  "main"`);
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ADMIN_ENV = { CMS_ADMIN_EMAIL: "you@example.com", CMS_ADMIN_NAME: "You", CMS_SITE_TITLE: "Acme", CMS_ADMIN_PASSWORD: "correct horse" };

let site: string;
async function makeSite(config: string): Promise<void> {
  await writeFile(path.join(site, "wrangler.jsonc"), config);
  await writeFile(path.join(site, "package.json"), JSON.stringify({ dependencies: { next: "16" }, devDependencies: { "@opennextjs/cloudflare": "1" } }));
  await writeFile(path.join(site, "pnpm-lock.yaml"), "");
  await mkdir(path.join(site, "migrations"));
  await writeFile(path.join(site, "migrations", "0001_init.sql"), "select 1;");
  await mkdir(path.join(site, "node_modules", ".bin"), { recursive: true });
  await writeFile(path.join(site, "node_modules", ".bin", "wrangler"), "");
}

beforeEach(async () => {
  site = await mkdtemp(path.join(tmpdir(), "cms-deploy-"));
});
afterEach(async () => {
  await rm(site, { recursive: true, force: true });
});

interface Call {
  line: string;
  env?: Readonly<Record<string, string>>;
}

/** Answers the project's tools; writes wrangler's output records like wrangler does. */
function projectExec(o: { fail?: string; signedIn?: boolean; onCall?: (line: string) => void } = {}): { exec: Executor; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Executor = async (cmd, args, opts: ExecOptions): Promise<ExecResult> => {
    const line = [path.basename(cmd), ...args.filter((a) => !a.includes(path.sep) || a.startsWith("scripts"))].join(" ");
    calls.push({ line, env: opts.env });
    o.onCall?.(line);
    const out = opts.env?.WRANGLER_OUTPUT_FILE_PATH;
    if (o.fail && line.startsWith(o.fail)) {
      if (out) appendFileSync(out, `${JSON.stringify({ type: "command-failed", message: "Your Worker exceeded the size limit" })}\n`);
      return { code: 1, stdout: "", stderr: "✘ [ERROR] it broke" };
    }
    if (line.startsWith("wrangler whoami")) return { code: 0, stdout: JSON.stringify({ loggedIn: o.signedIn ?? true }), stderr: "" };
    if (out && line.startsWith("opennextjs-cloudflare upload")) appendFileSync(out, `${JSON.stringify({ type: "version-upload", version_id: "new-version-id" })}\n`);
    if (out && line.startsWith("opennextjs-cloudflare deploy")) {
      appendFileSync(out, `${JSON.stringify({ type: "deploy", version_id: "first-version", targets: ["https://cms-acme.example.workers.dev"] })}\n`);
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

function existingWorker(): FakeCloudflare {
  return fakeCloudflare({
    identity: { authenticated: true, source: { kind: "oauth", label: "signed in through cf" }, accounts: [{ id: ACCOUNT, name: "Acme" }] },
    workers: { "cms-acme": { name: "cms-acme", workersDevUrl: "https://cms-acme.example.workers.dev", deployments: [], versions: [], secrets: ["SECRETS_KEY", "AUTH_PEPPER", "SETUP_TOKEN"] } },
    d1: [{ id: "db-1", name: "cms-acme-db" }],
    pending: { "db-1": ["0002_more.sql"] },
    r2: ["cms-acme-storage", "cms-acme-next-cache"],
    lifecycle: { "cms-acme-next-cache": [{ id: "expire-page-cache", enabled: true, conditions: { prefix: "incremental-cache/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 2592000 } } }] },
    query: (_id, sql) => (sql.startsWith("SELECT COUNT") ? [{ count: 2 }] : []),
  });
}

function freshAccount(): FakeCloudflare {
  return fakeCloudflare({
    identity: { authenticated: true, source: { kind: "oauth", label: "signed in through cf" }, accounts: [{ id: ACCOUNT, name: "Acme" }] },
    lifecycle: { "cms-acme-next-cache": [{ id: "Default Multipart Abort Rule", enabled: true, conditions: {} }] },
    query: (_id, sql) => (sql.startsWith("SELECT COUNT") ? [{ count: 0 }] : sql.startsWith("INSERT") ? [{ key: "core.siteUrl" }] : []),
  });
}

interface Harness {
  deps: Deps;
  port: FakePort;
  out: () => string;
  err: () => string;
  fetched: { url: string; body?: string }[];
  interrupt: () => void;
}

function harness(state: FakeCloudflare, exec: Executor, o: { env?: NodeJS.ProcessEnv; tty?: boolean; answers?: (boolean | string | "cancel")[]; status?: number } = {}): Harness {
  let stdout = "";
  let stderr = "";
  const answers = [...(o.answers ?? [])];
  const next = () => {
    const a = answers.shift();
    if (a === "cancel") throw cancelled();
    return a;
  };
  const prompt: Prompt = { confirm: async () => next() as boolean, select: async (_q, c) => c[0].value, text: async () => String(next()), secret: async () => String(next()) };
  const io: Io = {
    out: (t) => void (stdout += t), err: (t) => void (stderr += t),
    stdinTty: o.tty ?? false, stdoutTty: o.tty ?? false, stderrTty: false,
    env: o.env ?? {}, nodeVersion: "v22.12.0", now: () => new Date("2026-11-14T12:00:00Z"),
  };
  const fetched: Harness["fetched"] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    fetched.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    return url.endsWith("/api/setup") ? new Response(JSON.stringify({ ok: true })) : new Response("", { status: o.status ?? 200 });
  }) as typeof fetch;
  let handler: (() => void) | undefined;
  const port = createFakePort(state);
  return {
    deps: { io, exec, cloudflare: () => port, prompt, fetch: fetcher, sleep: async () => {}, onInterrupt: (h) => ((handler = h), () => (handler = undefined)) },
    port, out: () => stdout, err: () => stderr, fetched, interrupt: () => handler?.(),
  };
}

const run = (h: Harness, argv: string[]) => runNew(argv, site, "0.10.0", h.deps);
const writes = (p: FakePort) => p.calls.filter((c) => /^(d1Create|r2Create|r2SetLifecycleRules|putSecret|promote)/.test(c) || c.includes("INSERT"));

describe("cms deploy — a Worker that exists", () => {
  it("uploads a version that is not live, migrates, then promotes it", async () => {
    await makeSite(ACME);
    const { exec, calls } = projectExec();
    const h = harness(existingWorker(), exec);
    expect(await run(h, ["deploy", "--yes", "--json"])).toBe(0);
    expect(calls.map((c) => c.line)).toEqual([
      "wrangler whoami --json",
      "pnpm install --frozen-lockfile",
      "wrangler whoami --json",
      "opennextjs-cloudflare build --config",
      "opennextjs-cloudflare upload --config",
      "wrangler d1 migrations apply cms-acme-db --remote --config",
    ]);
    expect(calls.find((c) => c.line.startsWith("opennextjs-cloudflare upload"))?.env?.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT);
    expect(writes(h.port)).toEqual([`promote cms-acme new-version-id @${ACCOUNT}`, expect.stringContaining("INSERT INTO settings")]);
    const e = JSON.parse(h.out());
    expect(e.data).toMatchObject({ mode: "update", url: "https://cms-acme.example.workers.dev", versionId: "new-version-id", admin: "exists", secretsCreated: [] });
    expect(e.data.steps.map((s: { name: string }) => s.name)).toEqual(["Dependencies", "Config", "Resources", "Build", "Upload", "Migrate", "Go live", "Secrets", "Site", "Check"]);
    expect(h.fetched.map((f) => f.url)).toEqual(["https://cms-acme.example.workers.dev/login"]);
  });

  it("adds the page-cache rule next to the bucket's existing rules, and writes a missing account_id", async () => {
    await makeSite(ACME_NO_ACCOUNT);
    const state = existingWorker();
    state.lifecycle = { "cms-acme-next-cache": [{ id: "Default Multipart Abort Rule", enabled: true, conditions: {} }] };
    const h = harness(state, projectExec().exec);
    expect(await run(h, ["deploy", "--yes", "--json"])).toBe(0);
    expect(h.port.calls).toContainEqual(expect.stringContaining("r2SetLifecycleRules cms-acme-next-cache Default Multipart Abort Rule,expire-page-cache"));
    expect(await readFile(path.join(site, "wrangler.jsonc"), "utf8")).toContain(`"account_id": "${ACCOUNT}"`);
  });

  it("runs the split step when the site has it", async () => {
    await makeSite(ACME);
    await mkdir(path.join(site, "scripts"));
    await writeFile(path.join(site, "scripts", "split-server-chunks.mjs"), "");
    const { exec, calls } = projectExec();
    await run(harness(existingWorker(), exec), ["deploy", "--yes", "--json"]);
    const lines = calls.map((c) => c.line);
    expect(lines.indexOf("node scripts/split-server-chunks.mjs --config")).toBe(lines.indexOf("opennextjs-cloudflare build --config") + 1);
  });

  it("a rejected upload leaves the live site unchanged and names the log", async () => {
    await makeSite(ACME);
    const h = harness(existingWorker(), projectExec({ fail: "opennextjs-cloudflare upload" }).exec);
    expect(await run(h, ["deploy", "--yes", "--json"])).toBe(1);
    const e = JSON.parse(h.out());
    expect(e.error.code).toBe("UPLOAD_REJECTED");
    expect(e.error.message).toContain("Your Worker exceeded the size limit");
    expect(e.data).toMatchObject({ state: "nothing-changed", liveSiteChanged: false });
    expect(e.data.completed.map((s: { name: string }) => s.name)).toEqual(["Dependencies", "Config", "Resources", "Build"]);
    expect(existsSync(path.join(site, e.data.log))).toBe(true);
    expect(await readFile(path.join(site, ".gitignore"), "utf8")).toContain("/.cms/");
    expect(writes(h.port)).toEqual([]);
  });

  it("a failed migration after the upload says the schema may be ahead", async () => {
    await makeSite(ACME);
    const h = harness(existingWorker(), projectExec({ fail: "wrangler d1 migrations" }).exec);
    expect(await run(h, ["deploy", "--yes", "--json"])).toBe(1);
    const e = JSON.parse(h.out());
    expect(e.error.code).toBe("MIGRATION_FAILED");
    expect(e.data).toMatchObject({ state: "schema-ahead", liveSiteChanged: false, versionId: "new-version-id" });
  });

  it("a failed check after going live says the new version is live", async () => {
    await makeSite(ACME);
    const h = harness(existingWorker(), projectExec().exec, { status: 500 });
    expect(await run(h, ["deploy", "--yes", "--json"])).toBe(1);
    expect(JSON.parse(h.out()).data).toMatchObject({ state: "live", liveSiteChanged: true });
    expect(JSON.parse(h.out()).error.code).toBe("HTTP_CHECK_FAILED");
  });

  it("Ctrl-C during the build stops there and lists what was done", async () => {
    await makeSite(ACME);
    const ref: { h?: Harness } = {};
    const { exec } = projectExec({ onCall: (line) => line.startsWith("opennextjs-cloudflare build") && ref.h?.interrupt() });
    const h = harness(existingWorker(), exec);
    ref.h = h;
    expect(await run(h, ["deploy", "--yes"])).toBe(130);
    expect(h.err()).toContain("Completed: Dependencies, Config, Resources.");
    expect(h.err()).toContain("Run `cms deploy --yes` again to continue");
    expect(h.err()).toContain("next: cms deploy --yes");
    expect(writes(h.port)).toEqual([]);
  });
});

describe("cms deploy — plan and confirmation", () => {
  it("--dry-run returns the plan and changes nothing", async () => {
    await makeSite(ACME);
    const { exec, calls } = projectExec();
    const h = harness(existingWorker(), exec);
    expect(await run(h, ["deploy", "--dry-run", "--json"])).toBe(0);
    const e = JSON.parse(h.out());
    expect(e.plan.map((p: { action: string; type: string }) => `${p.action} ${p.type}`)).toEqual([
      "install dependencies", "build worker", "upload version", "apply migrations", "promote version", "check http",
    ]);
    expect(calls.map((c) => c.line)).toEqual(["wrangler whoami --json"]);
    expect(writes(h.port)).toEqual([]);
  });

  it("non-interactive without --yes: CONFIRMATION_REQUIRED, nothing changed", async () => {
    await makeSite(ACME);
    const { exec, calls } = projectExec();
    const h = harness(existingWorker(), exec);
    expect(await run(h, ["deploy", "--json"])).toBe(3);
    expect(JSON.parse(h.out()).error.code).toBe("CONFIRMATION_REQUIRED");
    expect(calls).toHaveLength(1);
  });

  it("answering No: nothing changed, exit 130", async () => {
    await makeSite(ACME);
    const { exec, calls } = projectExec();
    const h = harness(existingWorker(), exec, { tty: true, answers: [false] });
    expect(await run(h, ["deploy"])).toBe(130);
    expect(h.err()).toContain("Plan");
    expect(h.err()).toContain("Nothing was changed.");
    expect(h.err()).toContain("cms deploy --dry-run");
    expect(calls).toHaveLength(1);
  });

  it("removed flags exit 2 with what replaced them; --site-slug still works as --name", async () => {
    await makeSite(ACME);
    const h = harness(existingWorker(), projectExec().exec);
    expect(await run(h, ["deploy", "--skip-migrations", "--json"])).toBe(2);
    expect(JSON.parse(h.out()).error).toMatchObject({ code: "FLAG_REMOVED" });
    const alias = harness(existingWorker(), projectExec().exec);
    expect(await run(alias, ["deploy", "--dry-run", "--site-slug", "acme", "--json"])).toBe(0);
    expect(JSON.parse(alias.out()).warnings).toContainEqual({ code: "FLAG_RENAMED", message: "--site-slug is now --name." });
  });

  it("stops before building when a required plugin setting is empty", async () => {
    await makeSite(ACME);
    await mkdir(path.join(site, "extensions", "blog"), { recursive: true });
    await writeFile(path.join(site, "extensions", "blog", "manifest.json"), JSON.stringify({ id: "blog", settings: [{ key: "title", label: "Title", type: "text", default: "", required: true }] }));
    const h = harness(existingWorker(), projectExec().exec);
    expect(await run(h, ["deploy", "--yes", "--json"])).toBe(3);
    expect(JSON.parse(h.out()).error).toMatchObject({ code: "SETTINGS_MISSING", next: ['add "EXT_BLOG_TITLE" to vars in wrangler.jsonc'] });
  });
});

describe("cms deploy — a new site", () => {
  it("non-interactive without inputs: INPUT_REQUIRED listing the env names", async () => {
    await makeSite(FRESH);
    const h = harness(freshAccount(), projectExec().exec);
    expect(await run(h, ["deploy", "--yes", "--json"])).toBe(3);
    const e = JSON.parse(h.out());
    expect(e.error.code).toBe("INPUT_REQUIRED");
    expect(e.data.missing.map((m: { env: string }) => m.env)).toEqual(["CMS_SITE_NAME", "CMS_ADMIN_EMAIL", "CMS_ADMIN_NAME", "CMS_SITE_TITLE", "CMS_ADMIN_PASSWORD"]);
  });

  it("refuses a name whose resources already exist (exit 4)", async () => {
    await makeSite(FRESH);
    const state = freshAccount();
    state.d1 = [{ id: "someone-else", name: "cms-acme-db" }];
    const h = harness(state, projectExec().exec, { env: ADMIN_ENV });
    expect(await run(h, ["deploy", "--name", "acme", "--yes", "--json"])).toBe(4);
    expect(JSON.parse(h.out()).error.code).toBe("NAME_IN_USE");
  });

  it("names the site, creates resources, migrates before the first deploy, then secrets and the first admin", async () => {
    await makeSite(FRESH);
    const state = freshAccount();
    const { exec, calls } = projectExec({
      onCall: (line) => {
        if (line.startsWith("opennextjs-cloudflare deploy")) {
          state.workers["cms-acme"] = { name: "cms-acme", deployments: [], versions: [], secrets: [] };
        }
      },
    });
    const h = harness(state, exec, { env: ADMIN_ENV });
    expect(await run(h, ["deploy", "--name", "acme", "--yes", "--json"])).toBe(0);
    const config = await readFile(path.join(site, "wrangler.jsonc"), "utf8");
    expect(config).toContain('"name": "cms-acme"');
    expect(config).toContain(`"account_id": "${ACCOUNT}"`);
    expect(config).toContain('"database_id": "id-cms-acme-db"');
    expect(config).toContain("// comments stay");
    const lines = calls.map((c) => c.line);
    expect(lines.indexOf("wrangler d1 migrations apply cms-acme-db --remote --config")).toBeLessThan(lines.indexOf("opennextjs-cloudflare deploy --config"));
    expect(lines).not.toContain("opennextjs-cloudflare upload --config");
    expect(writes(h.port).map((w) => w.split(" @")[0].split(" ").slice(0, 2).join(" "))).toEqual([
      "d1Create cms-acme-db", "r2Create cms-acme-storage", "r2Create cms-acme-next-cache",
      "r2SetLifecycleRules cms-acme-next-cache", "putSecret cms-acme", "putSecret cms-acme", "putSecret cms-acme", "query id-cms-acme-db",
    ]);
    expect(h.port.calls).toContainEqual(expect.stringContaining("r2SetLifecycleRules cms-acme-next-cache expire-page-cache"));
    const setup = h.fetched.find((f) => f.url.endsWith("/api/setup"));
    expect(JSON.parse(setup!.body!)).toMatchObject({ email: "you@example.com", password: "correct horse" });
    expect(JSON.parse(h.out()).data).toMatchObject({ mode: "first-deploy", admin: "created", siteUrlInitialized: true, secretsCreated: ["SECRETS_KEY", "AUTH_PEPPER", "SETUP_TOKEN"] });
    expect(h.out()).not.toContain("correct horse");
    expect(existsSync(path.join(site, ".cms", "bootstrap.json"))).toBe(false);
  });
});

describe("kept 0.x commands", () => {
  it("setup points at cms deploy with exit 2", async () => {
    await makeSite(ACME);
    const h = harness(existingWorker(), projectExec().exec);
    expect(await run(h, ["setup", "--site-slug", "acme", "--json"])).toBe(2);
    expect(JSON.parse(h.out()).error).toMatchObject({ code: "COMMAND_MOVED", next: ["cms deploy --dry-run", "cms deploy"] });
  });

  it("secrets creates only the missing keys and shows a new SETUP_TOKEN once, on stderr", async () => {
    await makeSite(ACME);
    const state = existingWorker();
    state.workers["cms-acme"].secrets = ["SECRETS_KEY"];
    const h = harness(state, projectExec().exec);
    expect(await run(h, ["secrets", "--json"])).toBe(0);
    expect(JSON.parse(h.out()).data).toMatchObject({ present: ["SECRETS_KEY"], created: ["AUTH_PEPPER", "SETUP_TOKEN"] });
    expect(h.err()).toContain("SETUP_TOKEN (copy it now");
    expect(h.out()).not.toContain("copy it now");
  });

  it("secrets --dry-run writes nothing; a missing Worker is SECRETS_UNREADABLE", async () => {
    await makeSite(ACME);
    const state = existingWorker();
    state.workers["cms-acme"].secrets = [];
    const dry = harness(state, projectExec().exec);
    expect(await run(dry, ["secrets", "--dry-run", "--json"])).toBe(0);
    expect(writes(dry.port)).toEqual([]);
    const gone = harness(freshAccount(), projectExec().exec);
    expect(await run(gone, ["secrets", "--json"])).toBe(1);
    expect(JSON.parse(gone.out()).error.code).toBe("SECRETS_UNREADABLE");
  });

  it("preflight --gate exits 10 on an empty required setting, and does not need a login", async () => {
    await makeSite(ACME);
    await mkdir(path.join(site, "extensions", "blog"), { recursive: true });
    await writeFile(path.join(site, "extensions", "blog", "manifest.json"), JSON.stringify({ id: "blog", settings: [{ key: "title", label: "Title", type: "text", default: "", required: true }, { key: "key", label: "Key", type: "text", default: "", secret: true, required: true }] }));
    const h = harness(fakeCloudflare({ identity: { authenticated: false, accounts: [] } }), projectExec().exec);
    expect(await run(h, ["preflight", "--gate"])).toBe(10);
    expect(h.out()).toMatch(/✗ {2}Setting EXT_BLOG_TITLE/);
    expect(h.out()).toMatch(/! {2}Setting EXT_BLOG_KEY/);
    const plain = harness(fakeCloudflare({ identity: { authenticated: false, accounts: [] } }), projectExec().exec);
    expect(await run(plain, ["preflight"])).toBe(0);
  });
});

describe("cms init", () => {
  it("picks the newest release tag", () => {
    expect(newestReleaseTag("a\trefs/tags/v1.9.0\nb\trefs/tags/v2.0.0\nc\trefs/tags/v2.0.0-rc.1\nd\trefs/tags/v1.10.3\n")).toBe("v2.0.0");
    expect(newestReleaseTag("")).toBeUndefined();
  });

  it("clones that tag; create is the old name and says so", async () => {
    const calls: string[] = [];
    const exec: Executor = async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (args[0] === "ls-remote") return { code: 0, stdout: "x\trefs/tags/v2.0.0\ny\trefs/tags/v2.1.0\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const h = harness(fakeCloudflare(), exec);
    expect(await run(h, ["create", "acme", "--json"])).toBe(0);
    expect(calls).toContain("git clone --depth 1 --branch v2.1.0 https://github.com/sz-ws/cms.git acme");
    expect(JSON.parse(h.out()).warnings).toContainEqual({ code: "COMMAND_RENAMED", message: "`cms create` is now `cms init`." });
  });

  it("says so when the template has no release tag", async () => {
    const exec: Executor = async () => ({ code: 0, stdout: "", stderr: "" });
    const h = harness(fakeCloudflare(), exec);
    expect(await run(h, ["init", "acme", "--dry-run", "--json"])).toBe(0);
    expect(JSON.parse(h.out()).warnings[0].code).toBe("NO_RELEASE_TAG");
  });
});

describe("cms deploy — inputs and names", () => {
  it("asks for the site name when interactive", async () => {
    await makeSite(FRESH);
    const h = harness(freshAccount(), projectExec().exec, { tty: true, env: { ...ADMIN_ENV, NO_COLOR: "1" }, answers: ["acme"] });
    expect(await run(h, ["deploy", "--dry-run"])).toBe(0);
    expect(h.out()).toContain("+ d1      cms-acme-db");
    expect(await readFile(path.join(site, "wrangler.jsonc"), "utf8")).toBe(FRESH);
  });

  it("needs CMS_SETUP_TOKEN when the token exists on a Worker without users and none is saved", async () => {
    await makeSite(ACME);
    const state = existingWorker();
    state.query = (_id, sql) => (sql.startsWith("SELECT COUNT") ? [{ count: 0 }] : []);
    const h = harness(state, projectExec().exec, { env: ADMIN_ENV });
    expect(await run(h, ["deploy", "--dry-run", "--json"])).toBe(3);
    expect(JSON.parse(h.out()).data.missing).toEqual([{ input: "setup token from the earlier deployment", env: "CMS_SETUP_TOKEN", secret: true }]);
  });

  it("refuses names that do not all derive from the site slug", async () => {
    await makeSite(ACME.replace('"bucket_name": "cms-acme-storage"', '"bucket_name": "other-bucket"'));
    const h = harness(existingWorker(), projectExec().exec);
    expect(await run(h, ["deploy", "--dry-run", "--json"])).toBe(1);
    expect(JSON.parse(h.out()).error.code).toBe("CONFIG_INVALID");
  });

  it("init --deploy refuses a directory that cannot be a site name, before cloning", async () => {
    const calls: string[] = [];
    const h = harness(fakeCloudflare(), async (cmd, args) => (calls.push([cmd, ...args].join(" ")), { code: 0, stdout: "", stderr: "" }));
    expect(await run(h, ["init", "ab", "--deploy", "--json"])).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe("interactive answers are checked and asked again", () => {
  it("an invalid site name or email is explained and asked again", async () => {
    await makeSite(FRESH);
    const env = { CMS_ADMIN_NAME: "You", CMS_SITE_TITLE: "Acme", CMS_ADMIN_PASSWORD: "correct horse", NO_COLOR: "1" };
    const h = harness(freshAccount(), projectExec().exec, { tty: true, env, answers: ["y", "acme", "not-an-email", "you@example.com"] });
    expect(await run(h, ["deploy", "--dry-run"])).toBe(0);
    expect(h.err()).toContain('"y" cannot be a site name.');
    expect(h.err()).toContain("That is not an email address.");
    expect(h.out()).toContain("cms-acme-db");
  });

  it("Ctrl-C at a question cancels with 130", async () => {
    await makeSite(FRESH);
    const h = harness(freshAccount(), projectExec().exec, { tty: true, answers: ["y", "cancel"] });
    expect(await run(h, ["deploy", "--dry-run"])).toBe(130);
  });

  it("a bad value given by flag or env fails at once", async () => {
    await makeSite(FRESH);
    const h = harness(freshAccount(), projectExec().exec, { tty: true, env: { ...ADMIN_ENV, CMS_ADMIN_EMAIL: "nope" } });
    expect(await run(h, ["deploy", "--name", "y", "--dry-run", "--json"])).toBe(2);
    expect(JSON.parse(h.out()).error).toMatchObject({ code: "BAD_VALUE", next: ["cms deploy --name y --dry-run --json"] });
    const email = harness(freshAccount(), projectExec().exec, { tty: true, env: { ...ADMIN_ENV, CMS_ADMIN_EMAIL: "nope" } });
    expect(await run(email, ["deploy", "--name", "acme", "--dry-run", "--json"])).toBe(2);
    expect(JSON.parse(email.out()).error.message).toContain("CMS_ADMIN_EMAIL: That is not an email address.");
  });
});

describe("missing programs and re-run suggestions", () => {
  it("declining the cf install in a dry run suggests the same dry run again", async () => {
    await makeSite(ACME);
    const h = harness({ ...existingWorker(), readiness: { state: "missing" } }, projectExec().exec, { tty: true, answers: [false] });
    expect(await run(h, ["deploy", "--dry-run"])).toBe(3);
    expect(h.err()).toContain("next: cms deploy --dry-run");
    expect(h.err()).not.toMatch(/next: cms deploy$/m);
  });

  it("a missing package manager while installing cf is PACKAGE_MANAGER_MISSING with a way to get it", async () => {
    await makeSite(ACME);
    const state = { ...existingWorker(), readiness: { state: "missing" as const }, installError: new ProgramMissingError("pnpm") };
    const h = harness(state, projectExec().exec, { tty: true, answers: [true] });
    expect(await run(h, ["deploy", "--dry-run"])).toBe(3);
    expect(h.err()).toContain("pnpm is not installed");
    expect(h.err()).toContain("next: corepack enable pnpm");
    expect(h.err()).toContain("next: cms deploy --dry-run");
    expect(h.err()).not.toContain("ENOENT");
  });

  it("a missing package manager or project tool during deploy names it, and next repeats the command", async () => {
    await makeSite(ACME);
    const missing = (name: string): Executor => async (cmd, args, opts) => {
      if (path.basename(cmd) === name) throw new ProgramMissingError(cmd);
      return projectExec().exec(cmd, args, opts);
    };
    const pm = harness(existingWorker(), missing("pnpm"));
    expect(await run(pm, ["deploy", "--yes", "--json"])).toBe(3);
    expect(JSON.parse(pm.out()).error).toMatchObject({ code: "PACKAGE_MANAGER_MISSING", next: ["corepack enable pnpm", "npm install -g pnpm", "cms deploy --yes --json"] });
    const tool = harness(existingWorker(), missing("opennextjs-cloudflare"));
    expect(await run(tool, ["deploy", "--yes", "--json"])).toBe(3);
    expect(JSON.parse(tool.out()).error).toMatchObject({ code: "DEPENDENCIES_MISSING", next: ["pnpm install", "cms deploy --yes --json"] });
    expect(JSON.parse(tool.out()).error.message).toContain("node_modules/.bin/opennextjs-cloudflare");
  });

  it("a failed step suggests the command as it was run", async () => {
    await makeSite(ACME);
    const h = harness(existingWorker(), projectExec({ fail: "opennextjs-cloudflare build" }).exec);
    expect(await run(h, ["deploy", "--yes", "--json"])).toBe(1);
    expect(JSON.parse(h.out()).error.next).toEqual(["cms deploy --yes --json"]);
  });
});
