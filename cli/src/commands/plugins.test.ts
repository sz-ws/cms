import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakePort, fakeCloudflare, type FakeCloudflare } from "../cloudflare/fake.js";
import type { Executor } from "../exec.js";
import { recordingExecutor } from "../exec.js";
import type { Deps, Io } from "../frame/context.js";
import type { Prompt } from "../frame/prompt.js";
import { unpatchRegistryContent } from "../patch.js";
import { COUNT_LIMIT } from "./purge.js";
import { runNew } from "./router.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const CONFIG = `{
  "name": "cms-acme",
  "account_id": "${ACCOUNT}",
  "vars": { "CMS_SITE_SLUG": "acme", "EXT_SHOP_MERCHANT": "" },
  "d1_databases": [{ "binding": "DB", "database_name": "cms-acme-db", "database_id": "db-1", "migrations_dir": "migrations" }],
  "r2_buckets": [
    { "binding": "STORAGE", "bucket_name": "cms-acme-storage" },
    { "binding": "NEXT_INC_CACHE_R2_BUCKET", "bucket_name": "cms-acme-next-cache" }
  ]
}
`;
const REGISTRY = `// keep this comment
import type { Extension } from "@/ext/types";
import { shop } from "./shop";
import { shopOperations } from "./shop-operations";
import "./gallery-enhance";

export const registry: Extension[] = [shop, shopOperations];
`;

let site: string;
let registryDir: string;
beforeEach(async () => {
  site = await mkdtemp(path.join(tmpdir(), "cms-plugins-"));
  registryDir = await mkdtemp(path.join(tmpdir(), "cms-reg-"));
  await writeFile(path.join(site, "wrangler.jsonc"), CONFIG);
  await mkdir(path.join(site, "extensions", "shop", "admin"), { recursive: true });
  await mkdir(path.join(site, "extensions", "shop-operations"), { recursive: true });
  await writeFile(path.join(site, "extensions", "registry.ts"), REGISTRY);
  await writeFile(path.join(site, "extensions", "shop", "index.ts"), `export const shop = defineExtension({\n  id: "shop",\n  version: "0.14.1",\n});\n`);
  await writeFile(path.join(site, "extensions", "shop", "admin", "page.tsx"), "export {};\n");
  await writeFile(path.join(site, "extensions", "shop", "manifest.json"), JSON.stringify({ id: "shop", settings: [{ key: "merchant", label: "Merchant", type: "text", default: "", required: true }] }));
  await writeFile(path.join(site, "extensions", "shop-operations", "index.ts"), `export const shopOperations = defineExtension({\n  id: "shop-operations",\n  version: "0.19.0",\n});\n`);
  await writeFile(path.join(registryDir, "registry.json"), JSON.stringify({ extensions: [{ id: "shop", kind: "code", name: "Shop", version: "0.15.0", coreApi: "^2.0.0" }] }));
});
afterEach(async () => {
  await rm(site, { recursive: true, force: true });
  await rm(registryDir, { recursive: true, force: true });
});

function harness(state: FakeCloudflare, o: { exec?: Executor; tty?: boolean; answers?: (boolean | string)[] } = {}) {
  let stdout = "";
  let stderr = "";
  const answers = [...(o.answers ?? [])];
  const prompt: Prompt = { confirm: async () => answers.shift() as boolean, select: async (_q, c) => c[0].value, text: async () => String(answers.shift()), secret: async () => String(answers.shift()) };
  const io: Io = {
    out: (t) => void (stdout += t), err: (t) => void (stderr += t),
    stdinTty: o.tty ?? false, stdoutTty: o.tty ?? false, stderrTty: false,
    env: { NO_COLOR: "1" }, nodeVersion: "v22.12.0", now: () => new Date("2026-11-14T12:00:00Z"),
  };
  const port = createFakePort(state);
  const deps: Deps = { io, exec: o.exec ?? recordingExecutor().executor, cloudflare: () => port, prompt };
  return { deps, port, out: () => stdout, err: () => stderr };
}

type H = ReturnType<typeof harness>;
const run = (h: H, argv: string[]) => runNew(argv, site, "0.12.0", h.deps);
const json = (h: H) => JSON.parse(h.out());

function live(): FakeCloudflare {
  return fakeCloudflare({
    identity: { authenticated: true, source: { kind: "oauth", label: "signed in through cf" }, accounts: [{ id: ACCOUNT, name: "Acme" }] },
    workers: { "cms-acme": { name: "cms-acme", deployments: [], versions: [], secrets: [] } },
    query: (_id, sql) => (sql.includes("declarative_extensions") ? [{ id: "blog", version: "1.2.6", enabled: 1 }, { id: "contact", version: "1.3.3", enabled: 0 }] : []),
  });
}

describe("cms plugin list", () => {
  it("lists code plugins with updates and settings, and declarative ones from the database", async () => {
    const h = harness(live());
    expect(await run(h, ["plugin", "list", "--source", pathToFileURL(registryDir).href])).toBe(0);
    const text = h.out();
    expect(text).toMatch(/shop {3,}0\.14\.1 {3,}0\.15\.0 available · needs 1 setting/);
    expect(text).toMatch(/shop-operations {3,}0\.19\.0 {3,}registry: unknown/);
    expect(text).toMatch(/blog {3,}1\.2\.6 {3,}enabled/);
    expect(text).toMatch(/contact {3,}1\.3\.3 {3,}disabled/);
    expect(h.port.calls.some((c) => c.includes("SELECT id, version, enabled FROM declarative_extensions"))).toBe(true);
  });

  it("without a login shows the code plugins and warns why the rest is missing", async () => {
    const h = harness(fakeCloudflare({ identity: { authenticated: false, accounts: [] } }));
    expect(await run(h, ["plugin", "list", "--source", "file:///nonexistent-registry", "--json"])).toBe(0);
    const e = json(h);
    expect(e.data.code.map((p: { id: string }) => p.id)).toEqual(["shop", "shop-operations"]);
    expect(e.data.declarative).toBeNull();
    expect(e.warnings.map((w: { code: string }) => w.code)).toEqual(["REMOTE_UNREAD", "REGISTRY_UNREAD"]);
  });
});

describe("cms plugin configure", () => {
  it("non-interactive: INPUT_REQUIRED with the empty settings", async () => {
    const h = harness(live());
    expect(await run(h, ["plugin", "configure", "shop", "--json"])).toBe(3);
    expect(json(h).error).toMatchObject({ code: "INPUT_REQUIRED", next: ["cms plugin configure shop --json"] });
    expect(json(h).data.missing).toEqual([{ input: "EXT_SHOP_MERCHANT", env: "EXT_SHOP_MERCHANT" }]);
  });

  it("an unknown id suggests the nearest", async () => {
    const h = harness(live());
    expect(await run(h, ["plugin", "configure", "shpo", "--json"])).toBe(1);
    expect(json(h).error).toMatchObject({ code: "PLUGIN_NOT_FOUND", hint: "Did you mean shop?" });
  });
});

describe("cms plugin remove", () => {
  it("plans the files and the registry edit, warns that data stays, and removes with --yes", async () => {
    const dry = harness(live());
    expect(await run(dry, ["plugin", "remove", "shop", "--dry-run", "--json"])).toBe(0);
    expect(json(dry).plan.map((p: { name: string }) => p.name)).toEqual(["extensions/shop/admin/page.tsx", "extensions/shop/index.ts", "extensions/shop/manifest.json", "extensions/registry.ts"]);
    expect(json(dry).warnings.map((w: { code: string }) => w.code)).toEqual(["DATA_KEPT", "NEEDS_DEPLOY"]);
    expect(existsSync(path.join(site, "extensions", "shop"))).toBe(true);
    const h = harness(live());
    expect(await run(h, ["plugin", "remove", "shop", "--yes"])).toBe(0);
    expect(existsSync(path.join(site, "extensions", "shop"))).toBe(false);
    const registry = await readFile(path.join(site, "extensions", "registry.ts"), "utf8");
    expect(registry).toContain("export const registry: Extension[] = [shopOperations];");
    expect(registry).not.toContain('from "./shop";');
    expect(registry).toContain('import { shopOperations } from "./shop-operations";');
    expect(registry).toContain("// keep this comment");
  });

  it("needs --yes without a terminal; No keeps everything", async () => {
    const h = harness(live());
    expect(await run(h, ["plugin", "remove", "shop", "--json"])).toBe(3);
    const no = harness(live(), { tty: true, answers: [false] });
    expect(await run(no, ["plugin", "remove", "shop"])).toBe(130);
    expect(existsSync(path.join(site, "extensions", "shop", "index.ts"))).toBe(true);
  });
});

describe("unpatchRegistryContent", () => {
  it("removes the import and the array entry, and also a side-effect import", () => {
    const one = unpatchRegistryContent(REGISTRY, "shop-operations");
    expect(one).toMatchObject({ importRemoved: true, arrayRemoved: true });
    expect(one.content).toContain("export const registry: Extension[] = [shop];");
    expect(one.content).toContain('import { shop } from "./shop";');
    const side = unpatchRegistryContent(REGISTRY, "gallery-enhance");
    expect(side).toMatchObject({ importRemoved: true, arrayRemoved: false });
    expect(side.content).not.toContain("gallery-enhance");
  });
});

describe("cms upgrade", () => {
  function gitExec(o: { tags: string; core: string; migrations: string[] }): { exec: Executor; calls: string[] } {
    const calls: string[] = [];
    const exec: Executor = async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (args[0] === "ls-remote") return { code: 0, stdout: o.tags, stderr: "" };
      if (args[0] === "clone") {
        const dest = args[args.length - 1];
        await mkdir(path.join(dest, "src", "ext"), { recursive: true });
        await mkdir(path.join(dest, "migrations"), { recursive: true });
        await writeFile(path.join(dest, "src", "ext", "version.ts"), `export const CORE_API_VERSION = "${o.core}";\n`);
        for (const m of o.migrations) await writeFile(path.join(dest, "migrations", m), "");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    return { exec, calls };
  }

  it("reports the newest release, that the site is behind, and the new migrations; changes nothing", async () => {
    await mkdir(path.join(site, "src", "ext"), { recursive: true });
    await writeFile(path.join(site, "src", "ext", "version.ts"), `export const CORE_API_VERSION = "2.0.0";\n`);
    await mkdir(path.join(site, "migrations"));
    await writeFile(path.join(site, "migrations", "0001_a.sql"), "");
    const { exec, calls } = gitExec({ tags: "x\trefs/tags/v2.1.0\n", core: "2.1.0", migrations: ["0001_a.sql", "0002_b.sql"] });
    const h = harness(live(), { exec });
    expect(await run(h, ["upgrade", "--json"])).toBe(0);
    expect(json(h).data).toMatchObject({ core: "2.0.0", latest: "2.1.0", ref: "v2.1.0", behind: true, newMigrations: ["0002_b.sql"], changed: false });
    const clone = calls.find((c) => c.startsWith("git clone"))!;
    expect(clone).toContain("--depth 1 --branch v2.1.0");
    expect(existsSync(clone.split(" ").pop()!)).toBe(false);
  });

  it("falls back to the default branch with a warning", async () => {
    const { exec } = gitExec({ tags: "", core: "2.0.0", migrations: [] });
    const h = harness(live(), { exec });
    expect(await run(h, ["upgrade"])).toBe(0);
    expect(h.out()).toContain("default branch");
    expect(h.err()).toContain("has no release tag");
  });
});

describe("cms destroy --purge-objects", () => {
  function withObjects(counts: Record<string, number>): FakeCloudflare {
    const state = live();
    state.r2 = ["cms-acme-storage", "cms-acme-next-cache"];
    state.d1 = [{ id: "db-1", name: "cms-acme-db" }];
    state.objects = Object.fromEntries(Object.entries(counts).map(([b, n]) => [b, Array.from({ length: n }, (_, i) => `k${String(i).padStart(6, "0")}`)]));
    return state;
  }

  it("without the flag the refusal names it", async () => {
    const h = harness(withObjects({ "cms-acme-next-cache": 3 }));
    expect(await run(h, ["destroy", "--yes", "--confirm", "cms-acme", "--json"])).toBe(4);
    expect(json(h).error.next).toEqual(["cms destroy --yes --confirm cms-acme --json --purge-objects", "cms destroy --yes --confirm cms-acme --json"]);
    expect(json(h).error.hint).toContain("--purge-objects");
  });

  it("the plan counts the objects (or says at least) and the dry run deletes nothing", async () => {
    const h = harness(withObjects({ "cms-acme-next-cache": 2500, "cms-acme-storage": COUNT_LIMIT + 5 }));
    expect(await run(h, ["destroy", "--purge-objects", "--dry-run", "--json"])).toBe(0);
    const names = json(h).plan.map((p: { type: string; name: string }) => `${p.type} ${p.name}`);
    expect(names).toEqual([
      "worker cms-acme", "d1 cms-acme-db (db-1)",
      `objects cms-acme-storage: at least ${COUNT_LIMIT} objects`, "r2 cms-acme-storage",
      "objects cms-acme-next-cache: 2500 objects", "r2 cms-acme-next-cache",
    ]);
    expect(h.port.calls.filter((c) => /^(r2DeleteKeys|r2Delete|deleteWorker|d1Delete)/.test(c))).toEqual([]);
  });

  it("deletes objects in batches of 1000 before each bucket", async () => {
    const h = harness(withObjects({ "cms-acme-next-cache": 2500 }));
    expect(await run(h, ["destroy", "--purge-objects", "--yes", "--confirm", "cms-acme"])).toBe(0);
    expect(h.port.calls.filter((c) => /^(r2DeleteKeys|r2Delete)/.test(c)).map((c) => c.split(" @")[0])).toEqual([
      "r2Delete cms-acme-storage",
      "r2DeleteKeys cms-acme-next-cache 1000", "r2DeleteKeys cms-acme-next-cache 1000", "r2DeleteKeys cms-acme-next-cache 500",
      "r2Delete cms-acme-next-cache",
    ]);
    expect(h.err()).toContain("Deleted objects 2500 objects from cms-acme-next-cache");
  });

  it("stops when a batch does not go away", async () => {
    const state = withObjects({ "cms-acme-next-cache": 2 });
    const port = createFakePort(state);
    const h = harness(state);
    h.deps.cloudflare = () => ({ ...port, account: (id) => ({ ...port.account(id), r2DeleteKeys: async () => undefined }) });
    expect(await run(h, ["destroy", "--purge-objects", "--yes", "--confirm", "cms-acme", "--json"])).toBe(1);
    expect(json(h).error.message).toContain("were not deleted");
    expect(json(h).data.deleted).toEqual(["worker cms-acme", "d1 cms-acme-db (db-1)", "r2 cms-acme-storage"]);
  });
});

describe("cms destroy and Worker references", () => {
  it("deletes a Worker that only references itself with --delete-with-references; refuses one another Worker binds to", async () => {
    const self = live();
    self.workers["cms-acme"].referencedBy = ["cms-acme"];
    const h = harness(self);
    expect(await run(h, ["destroy", "--yes", "--confirm", "cms-acme"])).toBe(0);
    expect(h.port.calls).toContainEqual(`deleteWorker cms-acme with-references @${ACCOUNT}`);
    const other = live();
    other.workers["cms-acme"].referencedBy = ["cms-acme", "cms-other"];
    const o = harness(other);
    expect(await run(o, ["destroy", "--yes", "--confirm", "cms-acme", "--json"])).toBe(4);
    expect(json(o).error.code).toBe("WORKER_REFERENCED");
  });
});
