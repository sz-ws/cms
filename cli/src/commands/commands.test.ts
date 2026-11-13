import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePort, fakeCloudflare, type FakeCloudflare, type FakePort } from "../cloudflare/fake.js";
import { CloudflareError } from "../cloudflare/port.js";
import { recordingExecutor, type ExecResult, type RecordedCall } from "../exec.js";
import type { Deps, Io } from "../frame/context.js";
import { cancelled } from "../frame/errors.js";
import type { Prompt } from "../frame/prompt.js";
import { runNew } from "./router.js";

const NOW = new Date("2026-11-14T12:00:00Z");

const WRANGLER = `{
  // comments stay readable
  "name": "cms-acme",
  "workers_dev": true,
  "routes": [{ "pattern": "www.example.com", "custom_domain": true }],
  "vars": { "CMS_SITE_SLUG": "acme", "EXT_BLOG_TITLE": "Hello" },
  "d1_databases": [
    { "binding": "DB", "database_name": "cms-acme-db", "database_id": "db-1", "migrations_dir": "migrations" },
    { "binding": "NEXT_TAG_CACHE_D1", "database_name": "cms-acme-db", "database_id": "db-1" }
  ],
  "r2_buckets": [
    { "binding": "STORAGE", "bucket_name": "cms-acme-storage" },
    { "binding": "NEXT_INC_CACHE_R2_BUCKET", "bucket_name": "cms-acme-next-cache" }
  ]
}
`;

async function makeSite(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cms-site-"));
  await writeFile(path.join(dir, "wrangler.jsonc"), WRANGLER);
  await writeFile(path.join(dir, "package.json"), "{}");
  await mkdir(path.join(dir, "src", "ext"), { recursive: true });
  await writeFile(path.join(dir, "src", "ext", "version.ts"), `export const CORE_API_VERSION = "2.0.0";\n`);
  await mkdir(path.join(dir, "extensions", "blog"), { recursive: true });
  await writeFile(path.join(dir, "extensions", "registry.ts"), `import { blog } from "./blog";\nimport "./enhance";\n`);
  await writeFile(path.join(dir, "extensions", "blog", "index.ts"), `export const blog = defineExtension({\n  id: "blog",\n  version: "1.2.7",\n});\n`);
  await writeFile(
    path.join(dir, "extensions", "blog", "manifest.json"),
    JSON.stringify({ id: "blog", settings: [{ key: "title", label: "Title", type: "text", default: "", required: true }, { key: "apiKey", label: "API key", type: "text", default: "", secret: true, required: true }] }),
  );
  return dir;
}

function healthy(): FakeCloudflare {
  return fakeCloudflare({
    workers: {
      "cms-acme": {
        name: "cms-acme",
        workersDevUrl: "https://cms-acme.example.workers.dev",
        deployments: [{ id: "dep1", createdOn: "2026-11-14T10:00:00Z", versions: [{ versionId: "3f2a91c0-0000-0000-0000-000000000000", percentage: 100 }] }],
        versions: [
          { id: "3f2a91c0-0000-0000-0000-000000000000", number: 2, createdOn: "2026-11-14T09:59:00Z", source: "wrangler", message: "second" },
          { id: "11111111-0000-0000-0000-000000000000", number: 1, createdOn: "2026-11-13T09:00:00Z", source: "wrangler" },
        ],
        secrets: ["SECRETS_KEY", "AUTH_PEPPER", "SETUP_TOKEN", "EXT_BLOG_API_KEY"],
      },
    },
    d1: [{ id: "db-1", name: "cms-acme-db" }],
    r2: ["cms-acme-storage", "cms-acme-next-cache"],
    kv: [{ id: "kv-1", title: "cms-acme-kv" }, { id: "kv-2", title: "someone-else-kv" }],
  });
}

interface Harness {
  deps: Deps;
  port: FakePort;
  out: () => string;
  err: () => string;
  calls: RecordedCall[];
  asked: string[];
}

function harness(state: FakeCloudflare, o: { tty?: boolean; env?: NodeJS.ProcessEnv; answers?: (boolean | string | "cancel")[]; node?: string; execCode?: number } = {}): Harness {
  let stdout = "";
  let stderr = "";
  const asked: string[] = [];
  const answers = [...(o.answers ?? [])];
  const next = (q: string) => {
    asked.push(q);
    const a = answers.shift();
    if (a === "cancel") throw cancelled();
    return a;
  };
  const prompt: Prompt = {
    confirm: async (q) => next(q) as boolean,
    select: async (q, choices) => {
      const answer = next(q);
      return choices.find((c) => c.value === answer)!.value;
    },
  };
  const io: Io = {
    out: (t) => void (stdout += t),
    err: (t) => void (stderr += t),
    stdinTty: o.tty ?? false,
    stdoutTty: o.tty ?? false,
    stderrTty: false,
    env: o.env ?? {},
    nodeVersion: o.node ?? "v22.12.0",
    now: () => NOW,
  };
  const port = createFakePort(state);
  const recorder = recordingExecutor((): ExecResult => ({ code: o.execCode ?? 0, stdout: "", stderr: "" }));
  return { deps: { io, exec: recorder.executor, cloudflare: () => port, prompt }, port, out: () => stdout, err: () => stderr, calls: recorder.calls, asked };
}

let site: string;
beforeEach(async () => {
  site = await makeSite();
});
afterEach(async () => {
  await rm(site, { recursive: true, force: true });
});

const run = (h: Harness, argv: string[]) => runNew(argv, site, "0.9.0", h.deps);
const envelope = (h: Harness) => JSON.parse(h.out());

describe("cms status", () => {
  it("prints an aligned report on stdout and nothing on stderr", async () => {
    const h = harness(healthy());
    expect(await run(h, ["status"])).toBe(0);
    const text = h.out();
    expect(text).toMatch(/^Site {7}cms-acme {3,}core 2\.0\.0$/m);
    expect(text).toMatch(/^Account {4}Acme Studio {3,}signed in through cf$/m);
    expect(text).toContain("version 3f2a91c0");
    expect(text).toContain("deployed 2 hours ago");
    expect(text).toContain("https://www.example.com\n           https://cms-acme.example.workers.dev");
    expect(text).toMatch(/✓ d1 {7}cms-acme-db {3,}0 migrations pending/);
    expect(text).toMatch(/– kv {7}cms-acme-kv {3,}not used by 2\.0, safe to delete/);
    expect(text).not.toContain("someone-else-kv");
    expect(text).toContain("Secrets    3 of 3 set");
    expect(text).toContain("Plugins    blog 1.2.7");
    expect(h.err()).toBe("");
  });

  it("gives the same data as one JSON envelope with --json", async () => {
    const h = harness(healthy());
    expect(await run(h, ["status", "--json"])).toBe(0);
    const e = envelope(h);
    expect(e).toMatchObject({ ok: true, command: "status", plan: [], warnings: [], error: null });
    expect(e.data.site).toEqual({ worker: "cms-acme", core: "2.0.0", config: "wrangler.jsonc" });
    expect(e.data.account).toEqual({ id: "acc1", name: "Acme Studio", from: "only-account" });
    expect(e.data.live.versionId).toBe("3f2a91c0-0000-0000-0000-000000000000");
    expect(e.data.resources.map((r: { type: string; state: string }) => `${r.type}:${r.state}`)).toEqual(["worker:ok", "d1:ok", "r2:ok", "r2:ok", "kv:unused"]);
    expect(e.data.secrets.managed.every((m: { set: boolean }) => m.set)).toBe(true);
    expect(JSON.stringify(e)).not.toContain("you@example.com");
  });

  it("marks missing resources and a Worker that was never deployed", async () => {
    const h = harness(fakeCloudflare({ r2: ["cms-acme-storage"] }));
    expect(await run(h, ["status"])).toBe(0);
    expect(h.out()).toContain("Live       not deployed yet");
    expect(h.out()).toMatch(/✗ worker {3}cms-acme {3,}not deployed yet/);
    expect(h.out()).toMatch(/✗ d1 {7}cms-acme-db {3,}database_id not found on this account/);
    expect(h.out()).toMatch(/✗ r2 {7}cms-acme-next-cache {3,}missing/);
    expect(h.out()).toContain("Secrets    unknown");
  });

  it("reports pending migrations by name in JSON", async () => {
    const state = healthy();
    state.pending = { "db-1": ["0028_a.sql", "0029_b.sql"] };
    const h = harness(state);
    await run(h, ["status", "--json"]);
    expect(envelope(h).data.resources[1].pendingMigrations).toEqual(["0028_a.sql", "0029_b.sql"]);
    expect(h.port.calls).toContain("pending db-1 migrations @acc1");
  });

  it("leaves a gap and a warning when a read keeps failing", async () => {
    const state = healthy();
    state.failReads = new CloudflareError("TRANSIENT", "[10013] busy");
    const h = harness(state);
    expect(await run(h, ["status", "--json"])).toBe(0);
    const e = envelope(h);
    expect(e.warnings[0]).toMatchObject({ code: "READ_FAILED" });
    expect(e.data.resources[0].state).toBe("unknown");
  });

  it("stops with AUTH_INVALID (exit 3) when credentials are rejected", async () => {
    const state = healthy();
    state.failReads = new CloudflareError("AUTH_INVALID", "[10000] Authentication error");
    const h = harness(state);
    expect(await run(h, ["status", "--json"])).toBe(3);
    expect(envelope(h).error).toMatchObject({ code: "AUTH_INVALID", next: ["cms login"] });
  });

  it("fails with CONFIG_MISSING outside a site", async () => {
    const h = harness(healthy());
    expect(await runNew(["status", "--json"], tmpdir(), "0.9.0", h.deps)).toBe(1);
    expect(envelope(h).error.code).toBe("CONFIG_MISSING");
  });

  it("reads the site from -C", async () => {
    const h = harness(healthy());
    expect(await runNew(["-C", site, "status", "--json"], tmpdir(), "0.9.0", h.deps)).toBe(0);
  });
});

describe("connecting: cf, sign-in, account", () => {
  it("non-interactive without cf: CF_MISSING, exit 3, install command in next, no prompt", async () => {
    const h = harness(fakeCloudflare({ readiness: { state: "missing" } }));
    expect(await run(h, ["status", "--json"])).toBe(3);
    expect(envelope(h).error).toMatchObject({ code: "CF_MISSING", next: ["pnpm add -D cf@1.0.0-beta.32", "cms status --json"] });
    expect(h.asked).toEqual([]);
  });

  it("interactive without cf: asks once and installs", async () => {
    const h = harness({ ...healthy(), readiness: { state: "missing" } }, { tty: true, answers: [true] });
    expect(await run(h, ["status"])).toBe(0);
    expect(h.asked).toEqual(["Install it now? (pnpm add -D cf@1.0.0-beta.32)"]);
    expect(h.port.calls[0]).toBe("install");
    expect(h.err()).toContain("✓  Installed cf 1.0.0-beta.32");
  });

  it("interactive, answering No to the install: exit 3 and the command printed", async () => {
    const h = harness(fakeCloudflare({ readiness: { state: "missing" } }), { tty: true, answers: [false] });
    expect(await run(h, ["status"])).toBe(3);
    expect(h.err()).toContain("next: pnpm add -D cf@1.0.0-beta.32");
    expect(h.port.calls).not.toContain("install");
  });

  it("CI set means non-interactive even on a TTY", async () => {
    const h = harness(fakeCloudflare({ readiness: { state: "missing" } }), { tty: true, env: { CI: "1" } });
    expect(await run(h, ["status"])).toBe(3);
    expect(h.asked).toEqual([]);
  });

  it("Node too old: NODE_TOO_OLD", async () => {
    const h = harness(fakeCloudflare({ readiness: { state: "node-too-old", node: "v20.0.0" } }));
    expect(await run(h, ["status", "--json"])).toBe(3);
    expect(envelope(h).error.code).toBe("NODE_TOO_OLD");
  });

  it("a newer, untested cf is a warning, not an error", async () => {
    const h = harness({ ...healthy(), readiness: { state: "ready", version: "1.0.0-beta.40", command: "cf", untested: true } });
    expect(await run(h, ["status", "--json"])).toBe(0);
    expect(envelope(h).warnings[0].code).toBe("CF_VERSION_UNTESTED");
  });

  it("signed out, non-interactive: AUTH_REQUIRED with cms login", async () => {
    const h = harness(fakeCloudflare({ identity: { authenticated: false, accounts: [] } }));
    expect(await run(h, ["status", "--json"])).toBe(3);
    expect(envelope(h).error).toMatchObject({ code: "AUTH_REQUIRED", next: ["cms login"] });
  });

  it("signed out, interactive, No: exit 3 and the API-token route explained", async () => {
    const h = harness(fakeCloudflare({ identity: { authenticated: false, accounts: [] } }), { tty: true, answers: [false] });
    expect(await run(h, ["status"])).toBe(3);
    expect(h.err()).toContain("CLOUDFLARE_API_TOKEN");
    expect(h.port.calls).not.toContain("login");
  });

  it("signed out, interactive, Yes: runs cf's login and continues", async () => {
    const state = { ...healthy(), identity: { authenticated: false, accounts: [] }, afterLogin: healthy().identity };
    const h = harness(state, { tty: true, answers: [true] });
    expect(await run(h, ["status"])).toBe(0);
    expect(h.port.calls).toContain("login");
    expect(h.err()).toContain("Signed in as you@example.com");
  });

  it("several accounts, non-interactive: ACCOUNT_AMBIGUOUS with the accounts as data", async () => {
    const state = healthy();
    state.identity = { ...state.identity, accounts: [{ id: "a1", name: "One" }, { id: "a2", name: "Two" }] };
    const h = harness(state);
    expect(await run(h, ["status", "--json"])).toBe(3);
    const e = envelope(h);
    expect(e.error.code).toBe("ACCOUNT_AMBIGUOUS");
    expect(e.data.accounts).toHaveLength(2);
    expect(e.error.next).toContain("cms status --account a1");
  });

  it("several accounts, interactive: asks which; Ctrl-C cancels with 130", async () => {
    const state = healthy();
    state.identity = { ...state.identity, accounts: [{ id: "a1", name: "One" }, { id: "acc1", name: "Two" }] };
    const picked = harness(state, { tty: true, answers: ["acc1"] });
    expect(await run(picked, ["status"])).toBe(0);
    expect(picked.port.calls).toContain("worker cms-acme @acc1");
    const cancelledRun = harness(state, { tty: true, answers: ["cancel"] });
    expect(await run(cancelledRun, ["status"])).toBe(130);
    expect(cancelledRun.err()).toContain("Nothing was changed.");
  });

  it("uses --account, then CLOUDFLARE_ACCOUNT_ID", async () => {
    const flag = harness(healthy(), { env: { CLOUDFLARE_ACCOUNT_ID: "env-acc" } });
    await run(flag, ["status", "--json", "--account", "flag-acc"]);
    expect(envelope(flag).data.account).toMatchObject({ id: "flag-acc", from: "flag" });
    const env = harness(healthy(), { env: { CLOUDFLARE_ACCOUNT_ID: "env-acc" } });
    await run(env, ["status", "--json"]);
    expect(envelope(env).data.account).toMatchObject({ id: "env-acc", from: "env" });
  });
});

describe("cms doctor", () => {
  it("passes checks, fails a missing plugin setting, exits 10", async () => {
    await writeFile(path.join(site, "wrangler.jsonc"), WRANGLER.replace('"EXT_BLOG_TITLE": "Hello"', '"EXT_BLOG_TITLE": ""'));
    const h = harness(healthy());
    expect(await run(h, ["doctor"])).toBe(10);
    const text = h.out();
    expect(text).toMatch(/✓ {2}Node/);
    expect(text).toMatch(/✓ {2}cf {3,}1\.0\.0-beta\.32/);
    expect(text).toMatch(/✓ {2}Managed secrets/);
    expect(text).toMatch(/! {2}kv cms-acme-kv {3,}not used by 2\.0/);
    expect(text).toMatch(/✗ {2}Setting EXT_BLOG_TITLE/);
    expect(text).toContain('next: add "EXT_BLOG_TITLE" to vars in wrangler.jsonc');
    expect(h.err()).toContain("1 check failed.");
  });

  it("exits 0 when nothing fails, warnings included", async () => {
    const h = harness(healthy());
    expect(await run(h, ["doctor", "--json"])).toBe(0);
    const e = envelope(h);
    expect(e.ok).toBe(true);
    expect(e.data.summary.fail).toBe(0);
    expect(e.data.checks.find((c: { id: string }) => c.id === "setting:EXT_BLOG_API_KEY")).toBeUndefined();
  });

  it("reports a missing cf as a failing check instead of stopping, and never prompts", async () => {
    const h = harness(fakeCloudflare({ readiness: { state: "missing" } }), { tty: true });
    expect(await run(h, ["doctor", "--json"])).toBe(10);
    const e = envelope(h);
    expect(e.error.code).toBe("CHECKS_FAILED");
    expect(e.data.checks.find((c: { id: string }) => c.id === "cf")).toMatchObject({ status: "fail", next: ["pnpm add -D cf@1.0.0-beta.32"] });
    expect(h.asked).toEqual([]);
  });

  it("fails missing managed secrets with cms secrets as the next step", async () => {
    const state = healthy();
    state.workers["cms-acme"].secrets = ["SECRETS_KEY"];
    const h = harness(state);
    expect(await run(h, ["doctor", "--json"])).toBe(10);
    expect(envelope(h).error.next).toContain("cms secrets");
  });

  it("checks config even when Cloudflare is out of reach", async () => {
    const h = harness(fakeCloudflare({ identity: { authenticated: false, accounts: [] } }));
    expect(await runNew(["doctor", "--json"], tmpdir(), "0.9.0", h.deps)).toBe(10);
    const ids = envelope(h).data.checks.filter((c: { status: string }) => c.status === "fail").map((c: { id: string }) => c.id);
    expect(ids).toEqual(["config", "auth"]);
  });
});

describe("cms login", () => {
  it("reports the auth source when already signed in", async () => {
    const h = harness(healthy());
    expect(await run(h, ["login"])).toBe(0);
    expect(h.out()).toContain("Already signed in as you@example.com (signed in through cf).");
    expect(h.port.calls).not.toContain("login");
  });

  it("runs cf's login when interactive and signed out", async () => {
    const h = harness({ ...healthy(), identity: { authenticated: false, accounts: [] }, afterLogin: healthy().identity }, { tty: true });
    expect(await run(h, ["login", "--json"])).toBe(3);
    const i = harness({ ...healthy(), identity: { authenticated: false, accounts: [] }, afterLogin: healthy().identity }, { tty: true });
    expect(await run(i, ["login"])).toBe(0);
    expect(i.port.calls).toContain("login");
  });

  it("fails LOGIN_FAILED when cf's login does not complete", async () => {
    const h = harness({ ...healthy(), identity: { authenticated: false, accounts: [] }, loginSucceeds: false }, { tty: true });
    expect(await run(h, ["login"])).toBe(1);
    expect(h.err()).toContain("Signing in to Cloudflare did not complete.");
  });
});

describe("cms version list", () => {
  it("lists versions with the live one's traffic", async () => {
    const h = harness(healthy());
    expect(await run(h, ["version", "list"])).toBe(0);
    const lines = h.out().trim().split("\n");
    expect(lines[0]).toMatch(/^Version\s+No\.\s+Created\s+Traffic\s+Source\s+Message$/);
    expect(lines[1]).toMatch(/^3f2a91c0-0000-0000-0000-000000000000\s+2\s+2026-11-14 09:59 UTC\s+100%\s+wrangler\s+second$/);
    expect(lines[2]).not.toContain("%");
  });

  it("honours --limit and rejects a bad one", async () => {
    const h = harness(healthy());
    await run(h, ["version", "list", "--limit", "1", "--json"]);
    expect(envelope(h).data.versions).toHaveLength(1);
    const bad = harness(healthy());
    expect(await run(bad, ["version", "list", "--limit", "0", "--json"])).toBe(2);
  });

  it("says the Worker does not exist yet", async () => {
    const h = harness(fakeCloudflare());
    expect(await run(h, ["version", "list", "--json"])).toBe(1);
    expect(envelope(h).error).toMatchObject({ code: "WORKER_NOT_FOUND", next: ["cms deploy", "cms status"] });
  });
});

describe("cms logs", () => {
  it("hands the terminal to wrangler tail with the Worker and passthrough args", async () => {
    const h = harness(healthy());
    expect(await run(h, ["logs", "--json", "--", "--status", "error"])).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      cmd: "npx",
      args: ["wrangler", "tail", "cms-acme", "--format", "json", "--config", path.join(site, "wrangler.jsonc"), "--status", "error"],
    });
    expect(h.out()).toBe("");
  });

  it("maps a wrangler failure to WRANGLER_FAILED", async () => {
    const h = harness(healthy(), { execCode: 1 });
    expect(await run(h, ["logs"])).toBe(1);
    expect(h.err()).toContain("wrangler tail exited with code 1.");
  });
});

describe("help, unknown commands and flags", () => {
  it("bare cms prints the one-screen help with the agent note", async () => {
    const h = harness(healthy());
    expect(await run(h, [])).toBe(0);
    expect(h.out()).toContain("Agents: `cms help --json` lists everything");
  });

  it("help --json is the command table", async () => {
    const h = harness(healthy());
    expect(await run(h, ["help", "--json"])).toBe(0);
    const data = JSON.parse(h.out());
    expect(data.commands.length).toBeGreaterThan(10);
    expect(data.errorCodes.find((e: { code: string }) => e.code === "AUTH_REQUIRED")).toMatchObject({ exit: 3 });
  });

  it("help for one command, also through --help on a 0.x command", async () => {
    const h = harness(healthy());
    expect(await run(h, ["help", "version", "list"])).toBe(0);
    expect(h.out()).toContain("cms version list [flags]");
    const legacy = harness(healthy());
    expect(await run(legacy, ["setup", "--help"])).toBe(0);
    expect(legacy.out()).toContain("--skip-migrations");
  });

  it("unknown command: exit 2 with a suggestion, no help dump", async () => {
    const h = harness(healthy());
    expect(await run(h, ["stauts"])).toBe(2);
    expect(h.err()).toContain("Did you mean `cms status`?");
    expect(h.err().split("\n").length).toBeLessThan(6);
    const j = harness(healthy());
    expect(await run(j, ["stauts", "--json"])).toBe(2);
    expect(envelope(j).error).toMatchObject({ code: "UNKNOWN_COMMAND", next: ["cms status", "cms help"] });
  });

  it("unknown flag on a table command: exit 2 with a suggestion", async () => {
    const h = harness(healthy());
    expect(await run(h, ["status", "--jsn"])).toBe(2);
    expect(h.err()).toContain("Did you mean --json?");
  });

  it("leaves 0.x commands and `cms version` to the 0.x dispatcher", async () => {
    const h = harness(healthy());
    expect(await run(h, ["setup", "--dry-run"])).toBeUndefined();
    expect(await run(h, ["version"])).toBeUndefined();
    expect(await run(h, ["--version"])).toBeUndefined();
  });
});

describe("site plugins", () => {
  it("reads id and version from defineExtension, falling back to the directory for a constant id", async () => {
    const { declared } = await import("../site/plugins.js");
    expect(declared(`const m = [{ id: "0001_x" }];\nexport const a = defineExtension({\n  id: "alpha",\n  version: "1.0.0",\n});`, "a")).toEqual({ id: "alpha", version: "1.0.0" });
    expect(declared(`export const m = defineExtension({\n  id: MEMBERS_ID,\n  migrations: [{ id: "0001_x" }],\n  version: "0.15.0",\n});`, "members")).toEqual({ id: "members", version: "0.15.0" });
  });
});
