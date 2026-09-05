import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Executor, ExecResult } from "./exec.js";
import { EXIT } from "./exit.js";
import { runSetup, type SetupOptions } from "./setup.js";
import { runPreflight } from "./preflight.js";
import { runSecrets, MANAGED_SECRETS, SETUP_TOKEN } from "./secrets.js";
import { readWranglerConfig } from "./wrangler-config.js";
import { adminCredentials, bootstrapAdmin, missingAdminEnv } from "./bootstrap.js";
import { bootstrapState } from "./bootstrap-state.js";

export const WORKER_LIMIT_BYTES = 64 * 1024 * 1024;

export interface DeployOptions extends SetupOptions {
  exec: Executor;
  siteUrl?: string;
  fetch?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
  /** 可注入,測試才不用真的等 bootstrap 的 503 退避。 */
  sleep?: (ms: number) => Promise<void>;
}

/** 兩處都要問同一件事(build 前的提早檢查、migration 後的權威判定),字面值只留一份。 */
const USER_COUNT_SQL = "SELECT COUNT(*) AS count FROM users";

/** Wrangler 的 gzip 數字只是資訊；容量門檻只讀 Total Upload。 */
export function uploadBytes(output: string): number | null {
  const m = /Total Upload:\s*([\d.]+)\s*(B|KiB|MiB)\b/.exec(output);
  if (!m) return null;
  const value = Number(m[1]) * ({ B: 1, KiB: 1024, MiB: 1024 ** 2 }[m[2]] ?? 0);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 專案自己的 wrangler 在不在。
 *
 * `cms deploy` 一律用 `<cwd>/node_modules/.bin/wrangler`(見 cli.ts 的接線),
 * 剛 clone 完的目錄裡那支還不存在。真的跑會先 `pnpm install` 補上,但 `--dry-run`
 * 不安裝任何東西 —— 直接往下走只會得到一行 `spawn … ENOENT`,那不是使用者能看懂的
 * 前置條件說明。cmd 不是絕對路徑時(測試注入 / npx 後援)不檢查:那條路徑的解析
 * 交給 PATH,不是我們能用 existsSync 判斷的。
 */
function wranglerMissing(client: { command: string }): boolean {
  return path.isAbsolute(client.command) && !existsSync(client.command);
}

/**
 * core.siteUrl 的 SQL 目前是字串插值組出來的,而 `.replaceAll("'", "''")` 不是一道
 * 夠寬的防線:`new URL("https://ex%27ample.com/").origin` 就會還原出一個帶單引號的
 * 主機名。所以在**產生 origin 的出口**再收一次,只放行純主機名(可帶埠號)的 https
 * origin —— 跳脫仍然保留,但不再是唯一擋著的東西。
 */
const SAFE_ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i;

function checkedOrigin(origin: string): string {
  if (!SAFE_ORIGIN_RE.test(origin)) {
    throw new Error(`Refusing to use ${origin} as the site URL: expected https://host or https://host:port and nothing else.`);
  }
  return origin;
}

export function siteOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("--site-url must be an HTTPS origin without credentials, path, query or fragment.");
  }
  return checkedOrigin(url.origin);
}

/** 只接受本次 Worker 的正式 workers.dev URL，排除文件連結和 preview URL。 */
export function deployedOrigin(output: string, workerName: string): string | null {
  for (const m of output.matchAll(/https:\/\/([a-z0-9-]+)\.([a-z0-9-]+)\.workers\.dev\b/g)) {
    if (m[1] === workerName) return checkedOrigin(m[0]);
  }
  return null;
}

export async function runDeploy(o: DeployOptions): Promise<number> {
  const r = o.reporter;
  let uploaded = false;
  // 已套用的 migration。收尾要靠它分辨兩種完全不同的處境:「什麼都沒發生」,
  // 以及「schema 已經走在還在跑的 Worker 前面」。
  const migrated: string[] = [];
  const run = async (label: string, command: string, args: string[]): Promise<ExecResult> => {
    const result = await r.task(label, () => o.exec(command, args, { cwd: o.cwd }));
    if (result.code !== 0) {
      throw new Error(`${label} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
    }
    return result;
  };

  try {
    // intro 一定要先印:前置驗證的失敗全部經由 catch 走 r.step("fail"),
    // 在 intro 之前丟出去的話,使用者看到的是一行沒有標題、不知道屬於哪個指令的錯誤。
    r.intro("cms deploy", "resources → build → size check → migrations → upload → secrets → HTTP check");
    if (o.skipMigrations || o.skipSecrets) {
      throw new Error("cms deploy requires migrations and managed-secret verification; skip flags are only supported by cms setup.");
    }
    const explicitOrigin = o.siteUrl ? siteOrigin(o.siteUrl) : null;
    // 提前驗證專案形狀，避免在錯誤目錄安裝依賴或建立遠端資源。
    readWranglerConfig(await readFile(o.configPath, "utf8"));
    const pkg = JSON.parse(await readFile(path.join(o.cwd, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (!pkg.dependencies?.next || !pkg.devDependencies?.["@opennextjs/cloudflare"]) {
      throw new Error("cms deploy must run inside a CMS project with Next.js and OpenNext installed in package.json.");
    }

    if (o.dryRun && wranglerMissing(o.client)) {
      r.step("fail", "project dependencies are not installed yet", "a dry run reads your Cloudflare account through the project's own Wrangler, and installs nothing itself.");
      r.outro([
        "run `pnpm install` first, then rerun `cms deploy --dry-run`,",
        "or run `cms deploy` without --dry-run — it installs the locked dependencies for you.",
      ]);
      return EXIT.SETUP_PREREQ;
    }
    if (o.dryRun) {
      r.note("deployment plan", [
        "install locked dependencies; connect the selected Cloudflare account and provision site resources",
        "build the Worker; enforce the 64 MiB uncompressed limit before migrations or upload",
        "apply pending migrations; deploy through OpenNext; create only missing managed secrets",
        "read back secret names; initialize site URL and the first administrator; check the deployed login page",
        "no installation, build, resource creation, migration, upload or secret generation in this dry run",
      ]);
      return await runSetup({ ...o, skipMigrations: true, skipSecrets: true, managedDeploy: true });
    }

    await run("installing locked dependencies", "pnpm", ["install", "--frozen-lockfile"]);
    if (wranglerMissing(o.client)) {
      r.step("fail", "Wrangler is still missing after installing dependencies", "expected the project to provide node_modules/.bin/wrangler.");
      r.outro([
        "check that package.json still lists wrangler as a devDependency and that `pnpm install` completed,",
        "then rerun cms deploy; nothing has been built, uploaded or created at this point.",
      ]);
      return EXIT.SETUP_PREREQ;
    }
    if (o.interactive && !(await o.client.whoami()).authenticated) {
      // 這一步刻意不進 r.task,也刻意不收子程序的輸出:wrangler 把 OAuth 授權網址
      // 印在自己的 stdout,而在 SSH / 容器裡瀏覽器開不起來,那行網址是使用者唯一的
      // 出路。收進字串 = 畫面上只剩一個永遠轉下去的圈;放進轉圈的重繪裡 = 網址被洗掉。
      r.step("todo", "opening Cloudflare login in your browser …",
        "wrangler prints an authorization URL below — open it manually if the browser does not.");
      const login = await o.exec(path.join(o.cwd, "node_modules", ".bin", "wrangler"), ["login"],
        { cwd: o.cwd, inheritStdio: true });
      if (login.code !== 0) {
        throw new Error(`wrangler login exited ${login.code}; authorize with \`pnpm exec wrangler login\` and rerun cms deploy.`);
      }
      r.step("ok", "Cloudflare account authorized");
    }
    const setupCode = await runSetup({ ...o, skipMigrations: true, skipSecrets: true, managedDeploy: true });
    if (setupCode !== EXIT.OK) return setupCode;
    const config = readWranglerConfig(await readFile(o.configPath, "utf8"));
    const database = config.d1.find((d) => d.binding === "DB");
    if (!database) throw new Error("CMS DB binding is missing.");

    const preflight = await runPreflight({
      extensionsDir: path.join(o.cwd, "extensions"), configPath: o.configPath,
      client: o.client, reporter: r, gate: true, managedDeploy: true,
    });
    if (preflight !== EXIT.OK) return preflight;

    const env = o.env ?? process.env;
    // 全新站少了管理員輸入的話,這次部署一定走不完 —— 那就現在講,不要讓人等完
    // 建置與 migration 才在最後一步失敗。權威判定仍在 migration 之後(那時 users
    // 表一定存在);這裡查不到表也當成全新站,寧可多問一次也不要浪費幾分鐘。
    if (!o.interactive) {
      const probe = await o.client.executeSql(database.databaseName, USER_COUNT_SQL, true);
      const existing = probe.rows?.[0]?.count;
      const fresh = typeof existing !== "number" || existing === 0;
      const missing = missingAdminEnv(env);
      if (fresh && missing.length > 0) {
        r.step("fail", `First deployment requires ${missing.join(", ")} in the environment (or an interactive terminal).`,
          "nothing has been built, migrated or uploaded.");
        r.outro([
          "set the administrator inputs and rerun cms deploy:",
          "  export CMS_ADMIN_EMAIL=you@example.com CMS_ADMIN_NAME='Your Name' CMS_SITE_TITLE='Your Site'",
          "  read -rs CMS_ADMIN_PASSWORD && export CMS_ADMIN_PASSWORD   # keeps the password out of argv and shell history",
          "existing resources and managed keys are preserved.",
        ]);
        return EXIT.SETUP_PREREQ;
      }
    }

    const openNext = path.join(o.cwd, "node_modules", ".bin", "opennextjs-cloudflare");
    const wrangler = path.join(o.cwd, "node_modules", ".bin", "wrangler");
    const configArgs = ["--config", o.configPath];
    await run("building the Cloudflare Worker", openNext, ["build", ...configArgs]);
    const rehearsal = await run("checking Worker upload size", wrangler, ["deploy", "--dry-run", ...configArgs]);
    const bytes = uploadBytes(`${rehearsal.stdout}\n${rehearsal.stderr}`);
    if (bytes === null) throw new Error("Wrangler did not report Total Upload; bundle size could not be verified.");
    if (bytes > WORKER_LIMIT_BYTES) throw new Error(`Worker is ${(bytes / 1024 ** 2).toFixed(2)} MiB uncompressed; limit is 64 MiB.`);
    r.step("ok", `Worker size ${(bytes / 1024 ** 2).toFixed(2)} / 64 MiB uncompressed`);

    // 建置和容量先過關才改正式 schema。每個資料庫只套一次，重跑沿用 D1 applied 記錄。
    for (const name of new Set(config.d1.filter((d) => d.hasMigrationsDir).map((d) => d.databaseName))) {
      const result = await r.task(`applying migrations to ${name}`, () => o.client.applyMigrations(name));
      if (result.status !== "done") throw new Error(`migration failed: ${result.status === "failed" ? result.detail : "not executed"}`);
      migrated.push(name);
    }
    const users = await o.client.executeSql(database.databaseName, USER_COUNT_SQL, true);
    const userCount = users.rows?.[0]?.count;
    if (typeof userCount !== "number" || !Number.isInteger(userCount) || userCount < 0) {
      throw new Error(`Could not verify whether this site already has users in ${database.databaseName}${users.detail ? `: ${users.detail}` : ""}; refusing to bootstrap blindly.`);
    }
    const credentials = userCount === 0 ? await adminCredentials(o.prompter, o.interactive, env) : null;
    const recovery = bootstrapState(o.cwd, config.workerName ?? "", database.currentId ?? "");
    let setupToken = env.CMS_SETUP_TOKEN || await recovery.read();
    const deployment = await run("deploying the Worker", openNext, ["deploy", ...configArgs]);
    uploaded = true;
    const secretsCode = await runSecrets({
      client: o.client, reporter: r, dryRun: false, generateSecret: o.generateSecret, managedDeploy: true,
      onSetupToken: async (value) => {
        if (credentials) {
          await recovery.save(value);
          setupToken = value;
          return;
        }
        // 站上已經有管理員 → /api/setup 一律拒絕,這把新 token 沒有任何用途。
        // 但它確實換過了;不說一聲,使用者會以為手上那份舊值還有效。
        r.step("ok", `${SETUP_TOKEN} was missing and has been regenerated on the Worker`,
          "setup is already complete on this site, so the value is intentionally not shown — /api/setup refuses once users exist.");
      },
    });
    if (secretsCode !== EXIT.OK) throw new Error("managed secrets are incomplete; deployment is not ready.");
    const names = await o.client.listSecrets();
    if (!names || MANAGED_SECRETS.some((s) => !names.includes(s.name))) {
      throw new Error("managed secret readback failed; deployment is not ready.");
    }

    const origin = explicitOrigin ?? deployedOrigin(`${deployment.stdout}\n${deployment.stderr}`, config.workerName ?? "");
    if (!origin) throw new Error("Could not determine the deployed URL. Rerun cms deploy with --site-url https://your-domain.");
    // 只初始化未設定的 URL，客製網域和既有設定永不被 workers.dev 覆寫。
    const encodedOrigin = JSON.stringify(origin).replaceAll("'", "''");
    const initialized = await o.client.executeSql(database.databaseName,
      `INSERT INTO settings (key, value, updated_at) VALUES ('core.siteUrl', '${encodedOrigin}', ${Date.now()}) ON CONFLICT(key) DO NOTHING RETURNING key`);
    if (initialized.rows === null) {
      throw new Error(`Could not initialize the site URL in ${database.databaseName}${initialized.detail ? `: ${initialized.detail}` : ""}.`);
    }
    // RETURNING 只在真的插入時回一列。分得出來才有辦法只對「這次被釘住的人」說話 ——
    // 沿用既有設定的站不需要再被提醒一次。
    const siteUrlInitialized = initialized.rows.length > 0;
    if (credentials) {
      if (!setupToken && o.interactive) setupToken = await o.prompter.secret("Existing setup token (from the earlier deployment)");
      if (!setupToken) throw new Error("SETUP_TOKEN already exists and cannot be read back. Supply CMS_SETUP_TOKEN to resume first-admin setup; no existing key was rotated.");
      await r.task("creating the first administrator", () => bootstrapAdmin(origin, setupToken, credentials, o.fetch ?? globalThis.fetch, o.sleep));
    }
    await recovery.clear();
    // 不將第三方登入 redirect 算成此站健康；讀 body 前取消，避免保留連線。
    const response = await (o.fetch ?? globalThis.fetch)(`${origin}/login`, {
      redirect: "manual", signal: AbortSignal.timeout(20_000),
    });
    await response.body?.cancel();
    if (response.status !== 200) throw new Error(`login page returned HTTP ${response.status}: ${origin}/login`);
    r.outro([
      `✓ deployment verified: ${origin}`,
      "Worker uploaded, managed secrets verified, login page responds with HTTP 200.",
      credentials ? `Administrator created. Sign in at ${origin}/login` : `Existing administrator preserved. Sign in at ${origin}/login`,
      ...(siteUrlInitialized ? [
        `core.siteUrl was initialized to ${origin}.`,
        "OIDC redirect URIs, payment callbacks and absolute sitemap URLs are all derived from it — after attaching a custom domain,",
        "rerun with --site-url https://your-domain, or change core.siteUrl in Settings.",
      ] : []),
    ]);
    return EXIT.OK;
  } catch (error) {
    r.step("fail", error instanceof Error ? error.message : String(error));
    // 套了 migration 卻沒上傳成功,是所有失敗裡最需要講清楚的一種:線上那個 Worker
    // 還活著,而它現在跑的是舊程式碼、對著新 schema。說成「沒有完成,資源都保留著」
    // 等於把一個正在發生的不一致藏起來。
    const state = uploaded
      ? ["Worker was uploaded, but readiness checks did not finish. This is not a verified deployment."]
      : migrated.length > 0
        ? [
            `Migrations were applied to ${migrated.join(", ")}, but the new Worker was never uploaded.`,
            "Those databases are now ahead of the Worker that is still serving: the live site is running old code against the new schema.",
            "Rerun `cms deploy` now to finish the upload, or roll those databases back.",
          ]
        : ["Deployment did not complete."];
    r.outro([
      ...state,
      "Fix the reported error and rerun cms deploy with the same options; existing resources and managed keys are preserved.",
    ]);
    return EXIT.SETUP_FAILED;
  }
}
