import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePort, fakeCloudflare, type FakeCloudflare, type FakePort } from "../cloudflare/fake.js";
import { recordingExecutor } from "../exec.js";
import type { Deps, Io } from "../frame/context.js";
import { cancelled } from "../frame/errors.js";
import type { Prompt } from "../frame/prompt.js";
import { sinceMs } from "./logs.js";
import { runNew } from "./router.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const CONFIG = `{
  // the Worker
  "name": "cms-acme",
  "account_id": "${ACCOUNT}",
  // keeps workers.dev on
  "workers_dev": true,
  "vars": { "CMS_SITE_SLUG": "acme" },
  "d1_databases": [
    { "binding": "DB", "database_name": "cms-acme-db", "database_id": "db-1", "migrations_dir": "migrations" },
    { "binding": "NEXT_TAG_CACHE_D1", "database_name": "cms-acme-db", "database_id": "db-1" }
  ],
  "r2_buckets": [
    { "binding": "STORAGE", "bucket_name": "cms-acme-storage" },
    { "binding": "NEXT_INC_CACHE_R2_BUCKET", "bucket_name": "cms-acme-next-cache" }
  ],
  "kv_namespaces": [{ "binding": "CMS_KV", "id": "kv-1" }]
}
`;

const V = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-0000-0000-0000-000000000000`;

function cloud(): FakeCloudflare {
  return fakeCloudflare({
    identity: { authenticated: true, source: { kind: "oauth", label: "signed in through cf" }, accounts: [{ id: ACCOUNT, name: "Acme" }] },
    workers: {
      "cms-acme": {
        name: "cms-acme",
        deployments: [
          { id: "d3", createdOn: "2026-11-14T10:00:00Z", versions: [{ versionId: V(3), percentage: 100 }] },
          { id: "d2", createdOn: "2026-11-13T10:00:00Z", versions: [{ versionId: V(2), percentage: 100 }] },
        ],
        versions: [
          { id: V(3), createdOn: "2026-11-14T09:59:00Z" },
          { id: V(2), createdOn: "2026-11-13T09:59:00Z" },
          { id: V(1), createdOn: "2026-11-12T09:59:00Z" },
        ],
        secrets: ["SECRETS_KEY", "AUTH_PEPPER", "SETUP_TOKEN", "EXT_SHOP_KEY"],
      },
    },
    d1: [{ id: "db-1", name: "cms-acme-db" }],
    r2: ["cms-acme-storage", "cms-acme-next-cache"],
    kv: [{ id: "kv-1", title: "cms-acme-kv" }, { id: "kv-other", title: "someone-else" }],
    query: () => [{ name: "0001_init.sql", applied_at: "2026-11-01 00:00:00" }, { name: "0002_more.sql", applied_at: "2026-11-13 12:00:00" }],
  });
}

interface Harness {
  deps: Deps;
  port: FakePort;
  out: () => string;
  err: () => string;
}

function harness(state: FakeCloudflare, o: { tty?: boolean; answers?: (boolean | string | "cancel")[]; stdin?: string } = {}): Harness {
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
    stdinTty: o.stdin === undefined && (o.tty ?? false), stdoutTty: o.tty ?? false, stderrTty: false,
    env: { NO_COLOR: "1" }, nodeVersion: "v22.12.0", now: () => new Date("2026-11-14T12:00:00Z"),
  };
  const port = createFakePort(state);
  return {
    deps: { io, exec: recordingExecutor().executor, cloudflare: () => port, prompt, readStdin: async () => o.stdin ?? "" },
    port, out: () => stdout, err: () => stderr,
  };
}

let site: string;
beforeEach(async () => {
  site = await mkdtemp(path.join(tmpdir(), "cms-ops-"));
  await writeFile(path.join(site, "wrangler.jsonc"), CONFIG);
});
afterEach(async () => {
  await rm(site, { recursive: true, force: true });
});

const run = (h: Harness, argv: string[]) => runNew(argv, site, "0.11.0", h.deps);
const json = (h: Harness) => JSON.parse(h.out());
const writes = (p: FakePort) => p.calls.filter((c) => /^(promote|putSecret|deleteSecret|deleteWorker|d1Delete|r2Delete|kvDelete)/.test(c));

describe("cms rollback", () => {
  it("plans the previous version and warns about migrations applied since it was uploaded", async () => {
    const h = harness(cloud());
    expect(await run(h, ["rollback", "--dry-run", "--json"])).toBe(0);
    const e = json(h);
    expect(e.plan).toEqual([{ action: "promote", type: "version", name: `${V(2)} to 100%` }]);
    expect(e.data).toMatchObject({ from: V(3), to: V(2), laterMigrations: ["0002_more.sql"] });
    expect(e.warnings[0].code).toBe("SCHEMA_AHEAD");
    expect(writes(h.port)).toEqual([]);
  });

  it("promotes with --yes, takes an id prefix, and needs --yes without a terminal", async () => {
    const yes = harness(cloud());
    expect(await run(yes, ["rollback", "11111111", "--yes", "--json"])).toBe(0);
    expect(writes(yes.port)).toEqual([`promote cms-acme ${V(1)} @${ACCOUNT}`]);
    const no = harness(cloud());
    expect(await run(no, ["rollback", "--json"])).toBe(3);
    expect(json(no).error).toMatchObject({ code: "CONFIRMATION_REQUIRED", next: ["cms rollback --json --dry-run", "cms rollback --json --yes"] });
  });

  it("answering No changes nothing; an unknown id is BAD_VALUE; nothing earlier is NOTHING_TO_ROLL_BACK", async () => {
    const h = harness(cloud(), { tty: true, answers: [false] });
    expect(await run(h, ["rollback"])).toBe(130);
    expect(writes(h.port)).toEqual([]);
    const bad = harness(cloud());
    expect(await run(bad, ["rollback", "deadbeef", "--json"])).toBe(2);
    const state = cloud();
    state.workers["cms-acme"].deployments = state.workers["cms-acme"].deployments.slice(0, 1);
    const none = harness(state);
    expect(await run(none, ["rollback", "--json"])).toBe(1);
    expect(json(none).error.code).toBe("NOTHING_TO_ROLL_BACK");
  });
});

describe("cms domain", () => {
  it("adds and removes a custom domain, keeping comments", async () => {
    const h = harness(cloud());
    expect(await run(h, ["domain", "add", "www.example.com"])).toBe(0);
    expect(h.out()).toContain("takes effect at the next cms deploy");
    expect(h.err()).toContain("core.siteUrl");
    let text = await readFile(path.join(site, "wrangler.jsonc"), "utf8");
    expect(text).toContain('"routes": [{ "pattern": "www.example.com", "custom_domain": true }]');
    expect(text).toContain("// keeps workers.dev on");
    await run(harness(cloud()), ["domain", "add", "shop.example.com"]);
    const list = harness(cloud());
    await run(list, ["domain", "list", "--json"]);
    expect(json(list).data.domains).toEqual(["www.example.com", "shop.example.com"]);
    await run(harness(cloud()), ["domain", "remove", "www.example.com"]);
    text = await readFile(path.join(site, "wrangler.jsonc"), "utf8");
    expect(text).toContain('"routes": [{ "pattern": "shop.example.com", "custom_domain": true }]');
    expect(JSON.parse(text.replace(/\/\/.*$/gm, ""))).toBeTruthy();
  });

  it("refuses URLs and workers.dev, reports an unknown host, and --dry-run writes nothing", async () => {
    expect(await run(harness(cloud()), ["domain", "add", "https://www.example.com/"])).toBe(2);
    expect(await run(harness(cloud()), ["domain", "add", "cms-acme.example.workers.dev"])).toBe(2);
    const missing = harness(cloud());
    expect(await run(missing, ["domain", "remove", "nope.example.com", "--json"])).toBe(1);
    expect(json(missing).error.code).toBe("DOMAIN_NOT_FOUND");
    await run(harness(cloud()), ["domain", "add", "www.example.com", "--dry-run"]);
    expect(await readFile(path.join(site, "wrangler.jsonc"), "utf8")).toBe(CONFIG);
  });

  it("warns that routes turn workers.dev off when it is not set", async () => {
    await writeFile(path.join(site, "wrangler.jsonc"), CONFIG.replace('  "workers_dev": true,\n', ""));
    const h = harness(cloud());
    await run(h, ["domain", "add", "www.example.com", "--json"]);
    expect(json(h).warnings.map((w: { code: string }) => w.code)).toContain("WORKERS_DEV_OFF");
  });
});

describe("cms secret", () => {
  it("lists names only and marks the managed ones", async () => {
    const h = harness(cloud());
    expect(await run(h, ["secret", "list"])).toBe(0);
    expect(h.out()).toBe("AUTH_PEPPER  (managed by cms)\nEXT_SHOP_KEY\nSECRETS_KEY  (managed by cms)\nSETUP_TOKEN  (managed by cms)\n");
  });

  it("sets a new secret from stdin; the value appears nowhere in the output", async () => {
    const h = harness(cloud(), { stdin: "s3cr3t-value\n" });
    expect(await run(h, ["secret", "set", "EXT_NEW_KEY", "--json"])).toBe(0);
    expect(writes(h.port)).toEqual([`putSecret cms-acme EXT_NEW_KEY @${ACCOUNT}`]);
    expect(h.out() + h.err()).not.toContain("s3cr3t-value");
  });

  it("replacing an existing secret asks first; --yes accepts", async () => {
    const no = harness(cloud(), { tty: true, answers: [false] });
    expect(await run(no, ["secret", "set", "EXT_SHOP_KEY"])).toBe(130);
    expect(writes(no.port)).toEqual([]);
    const yes = harness(cloud(), { stdin: "v" });
    expect(await run(yes, ["secret", "set", "EXT_SHOP_KEY", "--yes"])).toBe(0);
    expect(yes.out()).toContain("Replaced EXT_SHOP_KEY");
  });

  it("refuses the managed secrets with exit 4 and says what would break", async () => {
    for (const [cmd, name] of [["set", "SECRETS_KEY"], ["delete", "AUTH_PEPPER"], ["set", "SETUP_TOKEN"]]) {
      const h = harness(cloud(), { stdin: "x" });
      expect(await run(h, ["secret", cmd, name, "--yes", "--json"])).toBe(4);
      expect(json(h).error.code).toBe("MANAGED_SECRET");
      expect(writes(h.port)).toEqual([]);
    }
  });

  it("deletes with --yes; an unknown name is SECRET_NOT_FOUND", async () => {
    const h = harness(cloud());
    expect(await run(h, ["secret", "delete", "EXT_SHOP_KEY", "--yes"])).toBe(0);
    expect(writes(h.port)).toEqual([`deleteSecret cms-acme EXT_SHOP_KEY @${ACCOUNT}`]);
    const gone = harness(cloud());
    expect(await run(gone, ["secret", "delete", "EXT_NOPE", "--yes", "--json"])).toBe(1);
    expect(json(gone).error.code).toBe("SECRET_NOT_FOUND");
  });

  it("there is no flag for a value", async () => {
    const h = harness(cloud());
    expect(await run(h, ["secret", "set", "EXT_X", "--value", "x", "--json"])).toBe(2);
    expect(json(h).error.code).toBe("UNKNOWN_FLAG");
  });
});

describe("cms logs --since", () => {
  it("parses durations up to 7 days", () => {
    expect(sinceMs("15m")).toBe(900_000);
    expect(sinceMs("7d")).toBe(604_800_000);
    expect(sinceMs("8d")).toBeNull();
    expect(sinceMs("15")).toBeNull();
  });

  it("reads recent errors through the port instead of tailing", async () => {
    const state = cloud();
    state.logs = [{ time: Date.parse("2026-11-14T11:59:00Z"), level: "error", message: "boom", trigger: "GET /x", outcome: "exception" }];
    const h = harness(state);
    expect(await run(h, ["logs", "--since", "1h"])).toBe(0);
    expect(h.out()).toBe("2026-11-14 11:59:00Z  error  GET /x [exception]  boom\n");
    expect(h.port.calls).toContain(`logs cms-acme 3600000 50 @${ACCOUNT}`);
    expect(await run(harness(cloud()), ["logs", "--since", "a week"])).toBe(2);
  });
});

describe("cms ci", () => {
  it("token lists account permissions, and zone ones only with custom domains", async () => {
    const plain = harness(cloud());
    await run(plain, ["ci", "token", "--json"]);
    const groups = json(plain).data.permissions.map((p: { group: string }) => p.group);
    expect(groups).toContain("Workers Scripts Write");
    expect(groups).not.toContain("Workers Routes Write");
    await run(harness(cloud()), ["domain", "add", "www.example.com"]);
    const zoned = harness(cloud());
    await run(zoned, ["ci", "token", "--json"]);
    expect(json(zoned).data).toMatchObject({ zones: ["www.example.com"] });
    expect(json(zoned).data.permissions.map((p: { group: string }) => p.group)).toContain("Workers Routes Write");
    expect(zoned.port.calls).toEqual([]);
  });

  it("init writes the workflow once; --force overwrites", async () => {
    await writeFile(path.join(site, "pnpm-lock.yaml"), "");
    const h = harness(cloud());
    expect(await run(h, ["ci", "init"])).toBe(0);
    const file = path.join(site, ".github", "workflows", "cms.yml");
    const text = await readFile(file, "utf8");
    expect(text).toContain("workflow_dispatch");
    expect(text).toContain("deploy --yes --json");
    expect(text).toContain("rollback ${{ inputs.version }} --yes --json");
    expect(text).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(text).toContain("pnpm install --frozen-lockfile");
    const again = harness(cloud());
    expect(await run(again, ["ci", "init", "--json"])).toBe(1);
    expect(json(again).error.code).toBe("DEST_EXISTS");
    expect(await run(harness(cloud()), ["ci", "init", "--force"])).toBe(0);
  });

  it("init --dry-run writes nothing", async () => {
    await run(harness(cloud()), ["ci", "init", "--dry-run"]);
    expect(existsSync(path.join(site, ".github"))).toBe(false);
  });
});

describe("cms destroy", () => {
  it("plans only this site's resources; --dry-run deletes nothing", async () => {
    const h = harness(cloud());
    expect(await run(h, ["destroy", "--dry-run", "--json"])).toBe(0);
    expect(json(h).plan.map((p: { type: string; name: string }) => `${p.type} ${p.name}`)).toEqual([
      "worker cms-acme", "d1 cms-acme-db (db-1)", "r2 cms-acme-storage", "r2 cms-acme-next-cache", "kv cms-acme-kv (kv-1)",
    ]);
    expect(writes(h.port)).toEqual([]);
  });

  it("refuses a non-empty bucket before deleting anything (exit 4)", async () => {
    const state = cloud();
    state.nonEmpty = ["cms-acme-next-cache"];
    const h = harness(state);
    expect(await run(h, ["destroy", "--yes", "--confirm", "cms-acme", "--json"])).toBe(4);
    expect(json(h).error.code).toBe("BUCKET_NOT_EMPTY");
    expect(writes(h.port)).toEqual([]);
  });

  it("--yes alone is never enough; --confirm must match; then Worker, D1, R2, KV in that order", async () => {
    const yes = harness(cloud());
    expect(await run(yes, ["destroy", "--yes", "--json"])).toBe(3);
    expect(json(yes).error.code).toBe("CONFIRMATION_REQUIRED");
    const wrong = harness(cloud());
    expect(await run(wrong, ["destroy", "--yes", "--confirm", "cms-other", "--json"])).toBe(2);
    expect(writes(wrong.port)).toEqual([]);
    const h = harness(cloud());
    expect(await run(h, ["destroy", "--yes", "--confirm", "cms-acme", "--json"])).toBe(0);
    expect(writes(h.port).map((w) => w.split(" @")[0])).toEqual([
      "deleteWorker cms-acme", "d1Delete db-1", "r2Delete cms-acme-storage", "r2Delete cms-acme-next-cache", "kvDelete kv-1",
    ]);
  });

  it("in a terminal the typed Worker name must match; otherwise nothing is deleted", async () => {
    const h = harness(cloud(), { tty: true, answers: ["acme"] });
    expect(await run(h, ["destroy"])).toBe(130);
    expect(h.err()).toContain("Nothing was deleted.");
    expect(writes(h.port)).toEqual([]);
    const ok = harness(cloud(), { tty: true, answers: ["cms-acme"] });
    expect(await run(ok, ["destroy", "--yes"])).toBe(0);
    expect(writes(ok.port)).toHaveLength(5);
  });

  it("a failed delete says what was already deleted", async () => {
    const state = cloud();
    const { CloudflareError } = await import("../cloudflare/port.js");
    state.failWrites = { r2Delete: new CloudflareError("FAILED", "[10008] bucket is not empty") };
    const h = harness(state);
    expect(await run(h, ["destroy", "--yes", "--confirm", "cms-acme", "--json"])).toBe(1);
    expect(json(h).data.deleted).toEqual(["worker cms-acme", "d1 cms-acme-db (db-1)"]);
    expect(json(h).error.next).toEqual(["cms destroy --yes --confirm cms-acme --json"]);
  });
});

describe("help covers the new commands", () => {
  it("lists them in help --json", async () => {
    const h = harness(cloud());
    await run(h, ["help", "--json"]);
    const names = json(h).commands.map((c: { name: string }) => c.name);
    for (const n of ["rollback", "domain list", "domain add", "domain remove", "secret list", "secret set", "secret delete", "ci token", "ci init", "destroy"]) {
      expect(names).toContain(n);
    }
  });

  it("an unknown sub-command suggests within its group", async () => {
    await mkdir(path.join(site, "x"), { recursive: true });
    const h = harness(cloud());
    expect(await run(h, ["secret", "lsit"])).toBe(2);
    expect(h.err()).toContain("cms secret list");
  });
});
