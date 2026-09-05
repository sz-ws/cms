import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runDeploy, uploadBytes, deployedOrigin, siteOrigin } from "./deploy.js";
import { WranglerClient } from "./wrangler.js";
import { createReporter, makeStyles, type Prompter } from "./ui.js";
import type { ExecOptions, Executor } from "./exec.js";
import { bootstrapAdmin } from "./bootstrap.js";
import { bootstrapState } from "./bootstrap-state.js";
import { parseArgs } from "./args.js";
import { EXIT } from "./exit.js";

let cwd: string;
const id = "11111111-2222-3333-4444-555555555555";
const origin = "https://cms-demo.example.workers.dev";
const env = { CMS_ADMIN_EMAIL: "owner@example.com", CMS_ADMIN_NAME: "Owner", CMS_ADMIN_PASSWORD: "private-test-password", CMS_SITE_TITLE: "Demo" };
const prompter: Prompter = {
  confirm: async () => true, text: async () => "demo", select: async (_q, options) => options[0].value,
  secret: async () => "unused",
};

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "cms-deploy-"));
  await mkdir(path.join(cwd, "extensions"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ dependencies: { next: "16" }, devDependencies: { "@opennextjs/cloudflare": "1" } }));
  await writeFile(path.join(cwd, "wrangler.jsonc"), JSON.stringify({
    name: "cms-demo", vars: { CMS_SITE_SLUG: "demo" },
    services: [{ binding: "WORKER_SELF_REFERENCE", service: "cms-demo" }],
    d1_databases: [
      { binding: "DB", database_name: "cms-demo-db", database_id: id, migrations_dir: "migrations" },
      { binding: "NEXT_TAG_CACHE_D1", database_name: "cms-demo-db", database_id: id },
    ],
    r2_buckets: [{ binding: "STORAGE", bucket_name: "cms-demo-storage" }, { binding: "NEXT_INC_CACHE_R2_BUCKET", bucket_name: "cms-demo-next-cache" }],
  }));
});
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

function harness(options: {
  fail?: string; size?: string; users?: number; http?: number; missingReadback?: boolean;
  setupStatus?: number; existingKeys?: boolean;
  /** 只有既有金鑰的一部分 —— 用來看「SETUP_TOKEN 被補回去」時說了什麼。 */
  keys?: string[];
  /** 第一次 whoami 回未登入,之後成功(登入流程跑完的樣子)。 */
  unauthenticated?: boolean;
  /** core.siteUrl 已經有值 → INSERT … DO NOTHING RETURNING 不回任何一列。 */
  siteUrlExists?: boolean;
} = {}) {
  const calls: string[] = [];
  const execOpts: { action: string; opts: ExecOptions }[] = [];
  const messages: string[] = [];
  const requests: { url: string; init?: RequestInit }[] = [];
  const keys = new Set(options.keys ?? (options.existingKeys ? ["SECRETS_KEY", "AUTH_PEPPER", "SETUP_TOKEN"] : []));
  let secretLists = 0;
  let whoamiCalls = 0;
  const exec: Executor = async (cmd, args, opts) => {
    const action = `${path.basename(cmd)} ${args.join(" ")}`;
    calls.push(action);
    execOpts.push({ action, opts });
    if (options.fail && action.includes(options.fail)) return { code: 1, stdout: "", stderr: "simulated failure" };
    let stdout = "";
    if (args[0] === "whoami") {
      whoamiCalls++;
      if (options.unauthenticated && whoamiCalls === 1) return { code: 1, stdout: "", stderr: "not logged in" };
      stdout = '{"email":"owner@example.com"}';
    }
    if (args[0] === "d1" && args[1] === "list") stdout = JSON.stringify([{ name: "cms-demo-db", uuid: id }]);
    if (args[0] === "d1" && args[1] === "execute") {
      const results = args.includes("SELECT COUNT(*) AS count FROM users")
        ? [{ count: options.users ?? 0 }]
        // RETURNING key 只有真的插入時才回一列;siteUrlExists 模擬「早就設定過」。
        : args.some((a) => a.includes("core.siteUrl")) && !options.siteUrlExists
          ? [{ key: "core.siteUrl" }]
          : [];
      stdout = JSON.stringify([{ success: true, results }]);
    }
    if (args[0] === "secret" && args[1] === "list") {
      secretLists++;
      stdout = JSON.stringify((options.missingReadback && secretLists > 1 ? [] : [...keys]).map((name) => ({ name })));
    }
    if (args[0] === "secret" && args[1] === "put") keys.add(args[2]);
    if (args.includes("--dry-run")) stdout = options.size ?? "Total Upload: 17194.50 KiB / gzip: 3936.79 KiB";
    if (path.basename(cmd) === "opennextjs-cloudflare" && args[0] === "deploy") stdout = `Deployed cms-demo\n  ${origin}`;
    return { code: 0, stdout, stderr: "" };
  };
  const client = new WranglerClient({ exec, cwd, cmd: "wrangler", prefix: [], dryRun: false });
  const reporter = createReporter({ write: (s: string) => messages.push(s), styles: makeStyles(false), animate: false });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    if (String(input).endsWith("/api/setup")) return Response.json({ ok: true }, { status: options.setupStatus ?? 200 });
    return new Response("login", { status: options.http ?? 200 });
  }) as typeof fetch;
  const run = (extra: Partial<Parameters<typeof runDeploy>[0]> = {}) => runDeploy({
    cwd, configPath: path.join(cwd, "wrangler.jsonc"), client, exec, reporter, prompter,
    dryRun: false, assumeYes: true, interactive: false, skipMigrations: false, skipSecrets: false,
    fetch: fetcher, env, generateSecret: () => "generated-private-token",
    // 503 的退避是真的會睡 3 秒的;測試不需要驗證時鐘。
    sleep: async () => {}, ...extra,
  });
  return { run, calls, execOpts, messages, requests };
}

describe("open-source deployment workflow", () => {
  it("owns install through first admin, verifies secrets, and never logs credentials", async () => {
    const h = harness();
    expect(await h.run()).toBe(0);
    const index = (needle: string) => h.calls.findIndex((s) => s.includes(needle));
    expect(index("pnpm install --frozen-lockfile")).toBe(0);
    expect(index("opennextjs-cloudflare build")).toBeLessThan(index("d1 migrations apply"));
    expect(index("deploy --dry-run")).toBeLessThan(index("d1 migrations apply"));
    expect(index("d1 migrations apply")).toBeLessThan(index("opennextjs-cloudflare deploy --config"));
    expect(h.calls.filter((s) => s.includes("d1 migrations apply"))).toHaveLength(1);
    const setup = h.requests.find((r) => r.url.endsWith("/api/setup"))!;
    expect(JSON.parse(String(setup.init?.body))).toMatchObject({ email: env.CMS_ADMIN_EMAIL, setupToken: "generated-private-token" });
    expect(setup.init?.redirect).toBe("manual");
    expect(h.messages.join(" ")).not.toContain("generated-private-token");
    expect(h.messages.join(" ")).not.toContain(env.CMS_ADMIN_PASSWORD);
    expect(h.calls.join(" ")).not.toContain("generated-private-token");
    expect(await bootstrapState(cwd, "cms-demo", id).read()).toBe("");
    // 留下一個空的 .cms/ 會讓人以為部署還有殘留的私有狀態要處理。
    await expect(stat(path.join(cwd, ".cms"))).rejects.toThrow();
    expect(await readFile(path.join(cwd, ".gitignore"), "utf8")).toContain("/.cms/");
  });

  it.each(["opennextjs-cloudflare build", "d1 migrations apply"])("stops before upload when %s fails", async (fail) => {
    const h = harness({ fail });
    expect(await h.run()).not.toBe(0);
    expect(h.calls.some((s) => s.includes("opennextjs-cloudflare deploy --config"))).toBe(false);
    expect(h.requests).toHaveLength(0);
  });

  it.each(["Total Upload: 65 MiB / gzip: 1 KiB", "gzip: 1 KiB"])("rejects oversized or unmeasured bundles before migrations: %s", async (size) => {
    const h = harness({ size });
    expect(await h.run()).not.toBe(0);
    expect(h.calls.some((s) => s.includes("migrations apply"))).toBe(false);
  });

  it("does not bootstrap when managed secrets cannot be verified", async () => {
    const h = harness({ missingReadback: true });
    expect(await h.run()).not.toBe(0);
    expect(h.requests).toHaveLength(0);
    expect(h.messages.join(" ")).toContain("not a verified deployment");
  });

  it("preserves existing users and keys without requiring first-admin inputs", async () => {
    const h = harness({ users: 2, existingKeys: true });
    expect(await h.run({ env: {} })).toBe(0);
    expect(h.requests.map((r) => r.url)).toEqual([`${origin}/login`]);
    expect(h.calls.some((s) => s.includes("secret put"))).toBe(false);
    expect(h.calls.some((s) => s.includes("ON CONFLICT(key) DO NOTHING"))).toBe(true);
  });

  it("retains a private, site-bound recovery token after interrupted bootstrap", async () => {
    const h = harness({ setupStatus: 503 });
    expect(await h.run()).not.toBe(0);
    expect(await bootstrapState(cwd, "cms-demo", id).read()).toBe("generated-private-token");
    expect(await bootstrapState(cwd, "cms-other", id).read()).toBe("");
    if (process.platform !== "win32") expect((await stat(path.join(cwd, ".cms/bootstrap.json"))).mode & 0o777).toBe(0o600);
    const retry = harness({ existingKeys: true });
    expect(await retry.run()).toBe(0);
    expect(retry.calls.some((s) => s.includes("secret put"))).toBe(false);
  });

  it("HTTP redirects do not count as a verified login page", async () => {
    const h = harness({ users: 1, existingKeys: true, http: 302 });
    expect(await h.run()).not.toBe(0);
  });

  it("dry run only discovers resources and does not install, build, migrate or contact the site", async () => {
    const h = harness();
    expect(await h.run({ dryRun: true })).toBe(0);
    expect(h.calls.every((s) => /whoami|d1 list|r2 bucket info/.test(s))).toBe(true);
    expect(h.requests).toHaveLength(0);
  });

  // 使用者沒下 --skip-migrations / --skip-secrets,而且這兩步之後真的會做。
  // 照抄旗標名等於在日誌裡留下一句假話,讀的人會以為 migration 沒跑。
  it.each([true, false])("never blames flags the user did not pass (dryRun=%s)", async (dryRun) => {
    const h = harness({ existingKeys: true, users: 1 });
    expect(await h.run({ dryRun })).toBe(0);
    const out = h.messages.join("");
    expect(out).not.toContain("--skip-");
    expect(out).toContain("cms deploy · resources");
    expect(out).not.toContain("sz-ws-cms");
  });

  // 非 TTY 下 task() 只印開頭那行的話,CI 日誌分不出「跑完了」跟「卡住了」。
  it("closes every long step with a result line in non-animated output", async () => {
    const h = harness({ existingKeys: true, users: 1 });
    expect(await h.run()).toBe(0);
    expect(h.messages.join("")).toMatch(/✓ installing locked dependencies \(\d+\.\d+s\)/);
    expect(h.messages.join("")).toMatch(/✓ deploying the Worker \(\d+\.\d+s\)/);
  });

  // 剛 clone 完就 `--dry-run` 的人拿到的原本是一行 spawn … ENOENT,那不是前置條件說明。
  it("explains missing dependencies instead of failing to spawn the project Wrangler", async () => {
    const calls: string[] = [];
    const messages: string[] = [];
    const exec: Executor = async (cmd, args) => {
      calls.push(`${path.basename(cmd)} ${args.join(" ")}`);
      return { code: 0, stdout: "", stderr: "" };
    };
    const client = new WranglerClient({
      exec, cwd, cmd: path.join(cwd, "node_modules", ".bin", "wrangler"), prefix: [], dryRun: true,
    });
    const code = await runDeploy({
      cwd, configPath: path.join(cwd, "wrangler.jsonc"), client, exec,
      reporter: createReporter({ write: (s: string) => messages.push(s), styles: makeStyles(false), animate: false }),
      prompter, dryRun: true, assumeYes: true, interactive: false,
      skipMigrations: false, skipSecrets: false, env,
    });
    expect(code).toBe(EXIT.SETUP_PREREQ);
    expect(messages.join("")).toContain("pnpm install");
    expect(messages.join("")).not.toContain("ENOENT");
    expect(calls).toHaveLength(0);
  });

  // wrangler 把 OAuth 授權網址印在自己的輸出上。收進字串的話,在開不了瀏覽器的
  // 機器(SSH / 容器)上,使用者面對的是一個永遠轉下去的圈。
  it("hands the terminal to wrangler login, and only when login is actually needed", async () => {
    const h = harness({ unauthenticated: true, existingKeys: true, users: 1 });
    expect(await h.run({ interactive: true })).toBe(0);
    const login = h.execOpts.filter((c) => c.action === "wrangler login");
    expect(login).toHaveLength(1);
    expect(login[0].opts.inheritStdio).toBe(true);
    expect(h.messages.join("")).toContain("opening Cloudflare login");

    const authorized = harness({ existingKeys: true, users: 1 });
    expect(await authorized.run({ interactive: true })).toBe(0);
    expect(authorized.calls.some((c) => c === "wrangler login")).toBe(false);

    // 非互動下更不能開登入流程:那裡沒有人可以按同意,只會卡住 CI。
    const headless = harness({ unauthenticated: true, existingKeys: true, users: 1 });
    await headless.run();
    expect(headless.calls.some((c) => c === "wrangler login")).toBe(false);
  });

  // 套了 migration 卻沒上傳成功 = 線上那個 Worker 正拿舊程式碼對著新 schema 跑。
  // 說成「沒有完成,資源都保留著」等於把一個正在發生的不一致藏起來。
  it("says the schema is ahead of the running Worker when the upload fails after migrations", async () => {
    const h = harness({ fail: "opennextjs-cloudflare deploy", existingKeys: true, users: 1 });
    expect(await h.run()).not.toBe(0);
    expect(h.calls.some((c) => c.includes("d1 migrations apply"))).toBe(true);
    const out = h.messages.join("");
    expect(out).toContain("cms-demo-db");
    expect(out).toContain("running old code against the new schema");
    expect(out).not.toContain("Deployment did not complete.");
  });

  // 管理員輸入到最後一步才用得到,但缺了就一定走不完。等建置跑完幾分鐘再說,
  // 是把可以立刻講的話留到最貴的時候講。
  it("refuses a fresh non-interactive deployment with missing administrator inputs before building", async () => {
    const h = harness();
    expect(await h.run({ env: {} })).toBe(EXIT.SETUP_PREREQ);
    expect(h.calls.some((c) => c.includes("opennextjs-cloudflare build"))).toBe(false);
    expect(h.calls.some((c) => c.includes("d1 migrations apply"))).toBe(false);
    const out = h.messages.join("");
    expect(out).toContain("CMS_ADMIN_EMAIL");
    expect(out).toContain("CMS_ADMIN_PASSWORD");
  });

  // users 表還不存在(從沒 migrate 過)也是全新站。查不到就放行的話,這一關對
  // 真正的第一次部署完全不會生效 —— 而那正是它唯一要保護的情境。
  it("treats an unreadable users table as a fresh site when checking inputs early", async () => {
    const h = harness({ fail: "d1 execute" });
    expect(await h.run({ env: {} })).toBe(EXIT.SETUP_PREREQ);
    expect(h.calls.some((c) => c.includes("opennextjs-cloudflare build"))).toBe(false);
  });

  // 「Could not verify …」少了 wrangler 自己的訊息與資料庫名字就無法診斷。
  it("surfaces the wrangler failure and the database name when the user count cannot be read", async () => {
    const h = harness({ fail: "d1 execute" });
    expect(await h.run()).not.toBe(0);
    const out = h.messages.join("");
    expect(out).toContain("cms-demo-db");
    expect(out).toContain("simulated failure");
  });

  // core.siteUrl 被釘在 workers.dev 上是靜默發生的,而 OIDC redirect、金流 callback
  // 與 sitemap 的絕對網址全都從它衍生。之後接自訂網域的人得知道去哪裡改。
  it("says core.siteUrl was pinned, and only when it actually pinned it", async () => {
    const h = harness({ users: 1, existingKeys: true });
    expect(await h.run()).toBe(0);
    const out = h.messages.join("");
    expect(out).toContain(`core.siteUrl was initialized to ${origin}`);
    expect(out).toContain("--site-url");
    const existing = harness({ users: 1, existingKeys: true, siteUrlExists: true });
    expect(await existing.run()).toBe(0);
    expect(existing.messages.join("")).not.toContain("core.siteUrl was initialized");
  });

  // 既有站台缺 SETUP_TOKEN 時我們會補一把新的,但它立刻就沒用了(/api/setup 一旦
  // 有使用者就一律拒絕)。默默換掉的話,使用者會以為手上那份舊值還有效。
  it("says the setup token was regenerated on a site that no longer needs it", async () => {
    const h = harness({ users: 4, keys: ["SECRETS_KEY", "AUTH_PEPPER"] });
    expect(await h.run()).toBe(0);
    const out = h.messages.join("");
    expect(out).toContain("SETUP_TOKEN was missing and has been regenerated");
    expect(out).toContain("intentionally not shown");
    expect(out).not.toContain("generated-private-token");
  });

  // 只比對最後一行的話,寫在 .gitignore 中間的 /.cms/ 會被漏掉,於是每次重跑都再追加一行。
  it("does not append a second /.cms/ line to a .gitignore that already has one", async () => {
    await writeFile(path.join(cwd, ".gitignore"), "node_modules\n/.cms/\n.next\n");
    await bootstrapState(cwd, "cms-demo", id).save("private-token");
    const lines = (await readFile(path.join(cwd, ".gitignore"), "utf8")).split("\n");
    expect(lines.filter((l) => l.trim() === "/.cms/")).toHaveLength(1);
  });

  it("rejects invalid URLs and skipped safety stages before any commands", async () => {
    for (const extra of [{ siteUrl: "http://example.com" }, { skipSecrets: true }, { skipMigrations: true }]) {
      const h = harness();
      expect(await h.run(extra)).not.toBe(0);
      expect(h.calls).toHaveLength(0);
    }
  });
});

describe("deployment size and URL parsing", () => {
  it("parses the one-command create and custom deployment URL", () => {
    expect(parseArgs(["create", "my-site", "--deploy"])).toMatchObject({ command: "create", id: "my-site", deployAfterCreate: true });
    expect(parseArgs(["deploy", "--site-url=https://cms.example.com"])).toMatchObject({ siteUrl: "https://cms.example.com" });
    expect(parseArgs(["deploy", "--site-url"])).toHaveProperty("error");
  });
  it("accepts the new limit regardless of compressed size", () => {
    expect(uploadBytes("Total Upload: 64 MiB / gzip: 11 MiB")).toBe(64 * 1024 ** 2);
    expect(uploadBytes("Total Upload: 1024 KiB / gzip: 50 KiB")).toBe(1024 ** 2);
  });
  it("does not mistake documentation or preview links for the deployed origin", () => {
    expect(deployedOrigin(`https://docs.example.com\nhttps://preview-cms-demo.example.workers.dev\n${origin}`, "cms-demo")).toBe(origin);
    expect(() => siteOrigin("https://user:password@example.com")).toThrow();
    // SQL 的單引號跳脫不是唯一防線:URL 會把 %27 還原成一個真的單引號。
    expect(() => siteOrigin("https://ex%27ample.com/")).toThrow();
  });
});

describe("first-administrator bootstrap", () => {
  const credentials = { email: "owner@example.com", name: "Owner", siteTitle: "Demo", password: "private-test-password" };
  function responder(statuses: readonly number[]) {
    let n = 0;
    const fetcher = (async () => {
      const status = statuses[Math.min(n++, statuses.length - 1)];
      return status === 200 ? Response.json({ ok: true }) : new Response("not ready", { status });
    }) as typeof fetch;
    return { fetcher, calls: () => n };
  }

  // secret put 之後,還沒換掉的 isolate 讀不到 SETUP_TOKEN,/api/setup 回 503。
  // 那是傳播時間差,不是設定錯誤 —— 但使用者看到的是一次失敗的部署。
  it("rides out the 503 window while the Worker picks up SETUP_TOKEN", async () => {
    const { fetcher, calls } = responder([503, 503, 200]);
    const slept: number[] = [];
    await bootstrapAdmin(origin, "token", credentials, fetcher, async (ms) => { slept.push(ms); });
    expect(calls()).toBe(3);
    expect(slept).toHaveLength(2);
  });

  it("gives up after the retries and says that is what happened", async () => {
    const { fetcher, calls } = responder([503]);
    await expect(bootstrapAdmin(origin, "token", credentials, fetcher, async () => {})).rejects.toThrow(/after 5 attempts/);
    expect(calls()).toBe(5);
  });

  // 403 / 500 再等也不會變好,重試只是把失敗延後 12 秒。
  it("does not retry a status that will not get better on its own", async () => {
    const { fetcher, calls } = responder([403]);
    await expect(bootstrapAdmin(origin, "token", credentials, fetcher, async () => {})).rejects.toThrow(/HTTP 403/);
    expect(calls()).toBe(1);
  });
});
