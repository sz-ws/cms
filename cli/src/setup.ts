// `sz-cms setup` —— 從「本機跑得起來」到「線上跑得起來」的引導流程。
//
// 取代 DEPLOY.md 的手工步驟:建兩組 D1 + 兩組 R2、把回傳的 id 貼回 wrangler.jsonc、
// 套 migrations、設 SECRETS_KEY。
//
// 冪等性怎麼保證的:每一步都先「看帳號上有什麼」再決定要不要動作,而不是記錄自己做過什麼。
//   - 先把這份 repo 的 site slug 寫成唯一資源名稱;只有這個本地租戶邊界已驗證後,
//     D1 才用**名字**去 `wrangler d1 list` 找,找到就沿用它的 uuid,不會重建。
//   - R2 先 `r2 bucket info`;真的去建到已存在的 bucket 也被當成成功。
//   - wrangler.jsonc 的值已經對了就完全不產生編輯。
//   - migrations 本來就有 applied 紀錄表,重跑是 no-op。
//   - SECRETS_KEY 已存在就跳過(**絕不覆寫** —— 換掉它等於把所有既存的加密設定變成亂碼)。
// 所以跑到一半斷掉的人,直接再跑一次就好。

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EXIT } from "./exit.js";
import type { Prompter, Reporter } from "./ui.js";
import type { WranglerClient } from "./wrangler.js";
import {
  ConfigShapeError,
  readWranglerConfig,
  writeSiteResources,
  writeD1Ids,
  type D1Entry,
  type SiteResources,
  type WranglerConfig,
} from "./wrangler-config.js";
import { JsoncParseError } from "./jsonc.js";

export const SECRETS_KEY = "SECRETS_KEY";

/** R2 最長名稱是 63;最長衍生值 cms-<slug>-next-cache 需要保留 15 字元。 */
export const SITE_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
const STOCK_SITE: SiteResources = {
  siteSlug: "",
  workerName: "cms",
  selfReferenceService: "cms",
  d1Names: ["cms-db", "cms-tag-cache"],
  r2Names: ["cms-storage", "cms-next-cache"],
};

export interface SetupOptions {
  cwd: string;
  /** wrangler.jsonc 的絕對路徑。 */
  configPath: string;
  client: WranglerClient;
  reporter: Reporter;
  prompter: Prompter;
  dryRun: boolean;
  /** 略過所有確認關卡(`--yes` / `--non-interactive`)。 */
  assumeYes: boolean;
  skipMigrations: boolean;
  skipSecrets: boolean;
  /** 新 clone 的站點識別;非互動(CI)時必填。 */
  siteSlug?: string;
  /** 明知只部署一個站點的開發帳號才准用預設共用名稱。 */
  allowSharedDefaultNames?: boolean;
  /** 可注入,測試才能斷言「送進 secret put 的就是這個值」。 */
  generateSecret?: () => string;
}

/** 32 byte base64 —— 與 DEPLOY.md 的 `openssl rand -base64 32` 等價。 */
export function defaultSecretGenerator(): string {
  return randomBytes(32).toString("base64");
}

interface D1Plan {
  entry: D1Entry;
  /** 帳號上已存在的 uuid;null = 要新建。 */
  existingUuid: string | null;
  /** 設定檔的值需不需要改。 */
  needsConfigWrite: boolean;
}

function planD1(config: WranglerConfig, accountDbs: { name: string; uuid: string }[]): D1Plan[] {
  // 這裡**不拿帳號資源名稱判定租戶**。新的 clone 碰到同名資源會在下方直接拒絕;
  // 只有已設定 slug 且六個名稱一致的 repo 才會走 reuse,所以此 lookup 能安全保留冪等。
  const byName = new Map(accountDbs.map((d) => [d.name, d.uuid]));
  return config.d1.map((entry) => {
    const existingUuid = byName.get(entry.databaseName) ?? null;
    return {
      entry,
      existingUuid,
      // 要新建的一定得寫;已存在的只有在值不一致時才寫(冪等)。
      needsConfigWrite:
        existingUuid === null || entry.currentId !== existingUuid,
    };
  });
}

/** 所有名稱都以同一個 site slug 衍生,避免一份 clone 落到別站的預設資源。 */
export function siteResourcesForSlug(siteSlug: string): SiteResources {
  const base = `cms-${siteSlug}`;
  return {
    siteSlug,
    workerName: base,
    selfReferenceService: base,
    d1Names: [`${base}-db`, `${base}-tag-cache`],
    r2Names: [`${base}-storage`, `${base}-next-cache`],
  };
}

export function validateSiteSlug(siteSlug: string): string | null {
  if (!SITE_SLUG_RE.test(siteSlug)) {
    return "site slug 必須是 3–48 字元的小寫英數或連字號,首尾不可是連字號。";
  }
  return null;
}

function sameSite(config: WranglerConfig, expected: SiteResources): boolean {
  return (
    config.siteSlug === expected.siteSlug &&
    config.workerName === expected.workerName &&
    config.selfReferenceService === expected.selfReferenceService &&
    config.d1.length === expected.d1Names.length &&
    config.r2.length === expected.r2Names.length &&
    config.d1.every((entry, i) => entry.databaseName === expected.d1Names[i]) &&
    config.r2.every((entry, i) => entry.bucketName === expected.r2Names[i])
  );
}

type SiteConfigState = "fresh" | "configured" | "unsafe";

function siteConfigState(config: WranglerConfig): SiteConfigState {
  if (sameSite(config, STOCK_SITE)) return "fresh";
  if (config.siteSlug && !validateSiteSlug(config.siteSlug) && sameSite(config, siteResourcesForSlug(config.siteSlug))) {
    return "configured";
  }
  return "unsafe";
}

interface PreparedSiteConfig {
  config: WranglerConfig;
  /** 非 null 代表確認後要以單次寫入完成六個租戶名稱與 slug。 */
  pending: SiteResources | null;
}

async function prepareSiteConfig(
  o: SetupOptions,
  configText: string,
  config: WranglerConfig,
  relConfig: string,
): Promise<PreparedSiteConfig | number> {
  const { reporter: r } = o;
  const state = siteConfigState(config);
  if (state === "configured") {
    if (o.siteSlug && o.siteSlug !== config.siteSlug) {
      r.step("fail", `這個 repo 已設定為 site slug「${config.siteSlug}」,拒絕改成「${o.siteSlug}」`);
      r.outro(["若這是不同客戶站,請從乾淨的 scaffold clone 開始,不要在既有站上改名。"]);
      return EXIT.SETUP_PREREQ;
    }
    r.step("ok", `site slug 已設定為「${config.siteSlug}」,保留既有資源名稱`);
    return { config, pending: null };
  }

  if (state === "unsafe") {
    r.step("fail", "wrangler.jsonc 的租戶命名不完整或不一致");
    r.outro([
      "為避免 setup 猜測並接管別站資源,拒絕依名稱推斷 site slug。",
      "請還原成乾淨 scaffold 後以 --site-slug <slug> 執行,或手動讓六個名稱與 vars.CMS_SITE_SLUG 一致。",
    ]);
    return EXIT.SETUP_PREREQ;
  }

  if (o.allowSharedDefaultNames) {
    if (o.siteSlug) {
      r.step("fail", "--allow-shared-default-names 不能和 --site-slug 一起使用");
      return EXIT.SETUP_PREREQ;
    }
    r.step("warn", "使用預設共用名稱", "僅限明確的單站或開發帳號;多站帳號會造成跨站資料存取。");
    return { config, pending: null };
  }

  let slug = o.siteSlug;
  if (!slug) {
    if (o.assumeYes) {
      r.step("fail", "新的 scaffold clone 仍是預設共用名稱,必須提供 site slug");
      r.outro([
        "CI / --yes 請加:sz-cms setup --site-slug <小寫站點識別> --yes",
        "只有明確的單站或開發帳號才可用:--allow-shared-default-names",
      ]);
      return EXIT.SETUP_PREREQ;
    }
    slug = await o.prompter.text("這是新的 CMS site;請輸入 site slug", "");
  }
  const invalid = validateSiteSlug(slug);
  if (invalid) {
    r.step("fail", `無效的 site slug「${slug}」`, invalid);
    r.outro(["例如:acme-taipei(不可用大寫、底線、句點或開頭/結尾連字號)。"]);
    return EXIT.SETUP_PREREQ;
  }

  const target = siteResourcesForSlug(slug);
  try {
    const preview = writeSiteResources(configText, target);
    r.step("todo", `site slug「${slug}」會寫入 ${relConfig}`, "Worker、self-reference、兩組 D1、兩組 R2 全部改為此站專屬名稱。");
    return { config: readWranglerConfig(preview.text), pending: target };
  } catch (e) {
    r.step("fail", `無法安全設定 ${relConfig}`, e instanceof Error ? e.message : String(e));
    return EXIT.SETUP_PREREQ;
  }
}

/** 給每個步驟收尾用:一定要講「現在該做什麼」,不能只說失敗。 */
function deployNextSteps(): string[] {
  return [
    "接下來:",
    "  1. pnpm deploy                     # opennextjs-cloudflare build + deploy",
    "  2. 開正式站的 /setup 建第一個管理員帳號(正式 D1 是空的,跟本機不共用)",
    "  3. Settings → core.siteUrl 設成你的公開網址",
    "     (OIDC redirect_uri、SEO canonical/sitemap/feed、金流 return URL 都需要絕對網址)",
    "  4. /admin/extensions 啟用一個 extension,建一筆內容,確認公開路由渲染得出來",
  ];
}

export async function runSetup(o: SetupOptions): Promise<number> {
  const { reporter: r, prompter, client } = o;
  const generateSecret = o.generateSecret ?? defaultSecretGenerator;
  const relConfig = path.relative(o.cwd, o.configPath) || o.configPath;

  r.intro(
    "sz-cms setup",
    o.dryRun
      ? "預演模式:只偵測與列出計畫,不建立任何資源、不改任何檔案。"
      : "把這個 repo 接上你自己的 Cloudflare 帳號。",
  );

  // ---- 1. 讀設定檔 ----
  let configText: string;
  try {
    configText = await readFile(o.configPath, "utf8");
  } catch (e) {
    r.step("fail", `讀不到 ${relConfig}`, e instanceof Error ? e.message : String(e));
    r.outro([
      "請確認你在 CMS repo 根目錄執行 `sz-cms setup`,",
      "或用 --config <路徑> 指定 wrangler 設定檔。",
    ]);
    return EXIT.SETUP_PREREQ;
  }

  let config: WranglerConfig;
  try {
    config = readWranglerConfig(configText);
  } catch (e) {
    const detail =
      e instanceof JsoncParseError || e instanceof ConfigShapeError
        ? e.message
        : String(e);
    r.step("fail", `${relConfig} 解析失敗`, detail);
    r.outro(["請先修好設定檔的格式,再重跑 `sz-cms setup`。"]);
    return EXIT.SETUP_PREREQ;
  }

  if (config.d1.length === 0 && config.r2.length === 0) {
    r.step("warn", `${relConfig} 裡沒有 d1_databases 也沒有 r2_buckets`);
    r.outro(["沒有需要建立的資源。若這不是預期結果,請確認設定檔內容。"]);
    return EXIT.OK;
  }

  // ---- 1.5. 先鎖定本 clone 的租戶命名,絕不由帳號上既有名稱反推 ----
  const prepared = await prepareSiteConfig(o, configText, config, relConfig);
  if (typeof prepared === "number") return prepared;
  config = prepared.config;

  // ---- 2. 登入狀態 ----
  const who = await r.task("檢查 wrangler 登入狀態", () => client.whoami());
  if (!who.authenticated) {
    r.step("fail", "wrangler 尚未登入");
    r.outro([
      "先登入,再重跑:",
      "  pnpm exec wrangler login",
      "  sz-cms setup",
      who.detail ? `\nwrangler 說:${who.detail}` : "",
    ].filter(Boolean));
    return EXIT.SETUP_PREREQ;
  }
  r.step("ok", `wrangler 已登入${who.detail ? `(${who.detail})` : ""}`);

  // ---- 3. 偵測現況 ----
  const accountDbs = await r.task("盤點帳號上的 D1", () => client.listD1());
  if (accountDbs === null) {
    r.step("fail", "讀不到帳號的 D1 清單");
    r.outro([
      "`wrangler d1 list --json` 失敗 —— 沒有這份清單就無法判斷哪些資源已經存在,",
      "硬做下去可能建出重複的資料庫。請先確認網路與帳號權限,再重跑。",
    ]);
    return EXIT.SETUP_PREREQ;
  }

  const d1Plans = planD1(config, accountDbs);
  if (prepared.pending) {
    const collisions = d1Plans.filter((p) => p.existingUuid).map((p) => p.entry.databaseName);
    if (collisions.length > 0) {
      r.step("fail", "新的 scaffold 不會認領帳號上已存在的 D1", collisions.join("、"));
      r.outro([
        "這代表 site slug 已被使用,或資源屬於另一個站。請改用新的 --site-slug。",
        "為保護租戶資料,只有已寫入相同 slug 的既有 repo 重跑時才會沿用同名資源。",
      ]);
      return EXIT.SETUP_PREREQ;
    }
  }
  for (const p of d1Plans) {
    if (p.existingUuid) {
      r.step(
        p.needsConfigWrite ? "todo" : "ok",
        `D1 ${p.entry.databaseName}(${p.entry.binding})已存在`,
        p.needsConfigWrite
          ? `設定檔要更新成 ${p.existingUuid}`
          : `設定檔的 database_id 已正確`,
      );
    } else {
      r.step("todo", `D1 ${p.entry.databaseName}(${p.entry.binding})要新建`);
    }
  }

  const r2States = new Map<string, boolean | null>();
  for (const bucket of config.r2) {
    const exists = await r.task(`檢查 R2 ${bucket.bucketName}`, () =>
      client.r2Exists(bucket.bucketName),
    );
    r2States.set(bucket.bucketName, exists);
    if (exists === true) {
      r.step("ok", `R2 ${bucket.bucketName}(${bucket.binding})已存在`);
    } else if (exists === false) {
      r.step("todo", `R2 ${bucket.bucketName}(${bucket.binding})要新建`);
    } else {
      r.step(
        "warn",
        `R2 ${bucket.bucketName}(${bucket.binding})狀態查不到`,
        "會嘗試建立;若其實已存在,wrangler 會回報 already exists,視為成功。",
      );
    }
  }

  if (prepared.pending) {
    const collisions = [...r2States].filter(([, state]) => state !== false).map(([name]) => name);
    if (collisions.length > 0) {
      r.step(
        "fail",
        "新的 scaffold 無法確認 R2 名稱尚未使用",
        collisions.join("、"),
      );
      r.outro([
        "請改用新的 --site-slug;查詢失敗時也必須先修正帳號權限或網路,不能冒險建立或認領 bucket。",
        "只有已寫入相同 slug 的既有 repo 重跑時才會沿用同名資源。",
      ]);
      return EXIT.SETUP_PREREQ;
    }
  }

  const willCreateD1 = d1Plans.filter((p) => !p.existingUuid).length;
  const willWriteConfig = d1Plans.filter((p) => p.needsConfigWrite).length;
  const willCreateR2 = [...r2States.values()].filter((v) => v !== true).length;
  const migrationTargets = config.d1.filter((e) => e.hasMigrationsDir);

  // ---- 4. 確認 ----
  if (o.dryRun) {
    r.note("預演結果", [
      `新建 D1:${willCreateD1} 個`,
      `新建 R2:${willCreateR2} 個`,
      `更新 ${relConfig} 的 database_id:${willWriteConfig} 處`,
      prepared.pending
        ? `設定 site slug:${prepared.pending.siteSlug}(會原子更新 7 個租戶欄位)`
        : "設定 site slug:沿用既有設定",
      o.skipMigrations
        ? "套用 migrations:略過(--skip-migrations)"
        : `套用 migrations:${migrationTargets.map((e) => e.databaseName).join("、") || "(無)"}`,
      o.skipSecrets ? "設定 SECRETS_KEY:略過(--skip-secrets)" : "設定 SECRETS_KEY:視現況",
    ]);
    r.outro(["預演結束,什麼都沒有改動。拿掉 --dry-run 就會實際執行。"]);
    return EXIT.OK;
  }

  if (willCreateD1 + willCreateR2 + willWriteConfig === 0) {
    r.step("ok", "資源與設定檔都已就緒,沒有要新建的東西。");
  } else if (!o.assumeYes) {
    const go = await prompter.confirm(
      `要建立 ${willCreateD1} 個 D1、${willCreateR2} 個 R2,並更新 ${relConfig} 嗎?`,
      true,
    );
    if (!go) {
      r.step("skip", "已中止,沒有建立任何資源、沒有改任何檔案。");
      r.outro(["想先看看會做什麼:sz-cms setup --dry-run"]);
      return EXIT.SETUP_ABORTED;
    }
  }

  const siteConfigResult = await persistSiteResources(o, prepared.pending, relConfig);
  if (siteConfigResult !== null) return siteConfigResult;

  // ---- 5. 建 D1 + 回填 id ----
  const assignments = new Map<string, string>();
  let failed: string | null = null;

  for (const p of d1Plans) {
    if (p.existingUuid) {
      assignments.set(p.entry.databaseName, p.existingUuid);
      continue;
    }
    const created = await r.task(`建立 D1 ${p.entry.databaseName}`, () =>
      client.createD1(p.entry.databaseName),
    );
    if (created.outcome.status === "failed") {
      r.step("fail", `建立 D1 ${p.entry.databaseName} 失敗`, created.outcome.detail);
      failed = `建立 D1 ${p.entry.databaseName} 失敗`;
      break;
    }
    if (created.uuid) {
      assignments.set(p.entry.databaseName, created.uuid);
      r.step("ok", `建立 D1 ${p.entry.databaseName}`, created.uuid);
    }
  }

  // 就算中途失敗也要把已經拿到的 id 寫回去 —— 不然下次重跑時設定檔仍是佔位值,
  // 使用者會以為什麼都沒成功。(重跑本身安全:D1 是用名字比對,不會建出第二個。)
  const configResult = await persistIds(o, assignments, relConfig);
  if (configResult !== null) return configResult;

  if (failed) {
    r.outro([`✗ ${failed}`, "修掉上面的錯誤之後直接重跑 `sz-cms setup`,已完成的步驟會自動略過。"]);
    return EXIT.SETUP_FAILED;
  }

  // ---- 6. 建 R2 ----
  for (const bucket of config.r2) {
    if (r2States.get(bucket.bucketName) === true) continue;
    const outcome = await r.task(`建立 R2 ${bucket.bucketName}`, () =>
      client.createR2(bucket.bucketName),
    );
    if (outcome.status === "failed") {
      r.step("fail", `建立 R2 ${bucket.bucketName} 失敗`, outcome.detail);
      r.outro([
        "修掉上面的錯誤之後重跑 `sz-cms setup`;已建好的資源會被偵測到並略過。",
      ]);
      return EXIT.SETUP_FAILED;
    }
    r.step("ok", `建立 R2 ${bucket.bucketName}`);
  }

  // ---- 7. migrations ----
  // 只對宣告了 migrations_dir 的 D1 跑。cms-tag-cache 沒有那個欄位,它的
  // revalidations 表由 opennextjs-cloudflare deploy 的 populate-cache 自己建
  // (schema 屬於 OpenNext,手抄一份進版控會漂移)。
  if (o.skipMigrations) {
    r.step("skip", "略過 migrations(--skip-migrations)");
  } else {
    for (const entry of migrationTargets) {
      const outcome = await r.task(`套用 migrations → ${entry.databaseName}`, () =>
        client.applyMigrations(entry.databaseName),
      );
      if (outcome.status === "failed") {
        r.step("fail", `套用 migrations 到 ${entry.databaseName} 失敗`, outcome.detail);
        r.outro([
          "資源都已建好,只差 migrations。修正後可單獨重跑:",
          `  pnpm exec wrangler d1 migrations apply ${entry.databaseName} --remote`,
          "或直接重跑 `sz-cms setup`(已完成的步驟會略過)。",
        ]);
        return EXIT.SETUP_FAILED;
      }
      r.step("ok", `migrations 已套用到 ${entry.databaseName}`);
    }
    for (const entry of config.d1) {
      if (!entry.hasMigrationsDir) {
        r.step(
          "skip",
          `${entry.databaseName} 不跑 migrations`,
          "設定檔沒宣告 migrations_dir;tag cache 的表由 OpenNext 部署時自建。",
        );
      }
    }
  }

  // ---- 8. SECRETS_KEY ----
  let secretNote: string[];
  if (o.skipSecrets) {
    r.step("skip", `略過 ${SECRETS_KEY}(--skip-secrets)`);
    secretNote = [
      `記得在部署後設定:openssl rand -base64 32 | pnpm exec wrangler secret put ${SECRETS_KEY}`,
    ];
  } else {
    secretNote = await ensureSecretsKey(o, generateSecret);
  }

  r.outro([...deployNextSteps(), ...(secretNote.length ? ["", ...secretNote] : [])]);
  return EXIT.OK;
}

/** 在任何遠端建立前,單次寫入租戶邊界。回傳 null 代表成功。 */
async function persistSiteResources(
  o: SetupOptions,
  target: SiteResources | null,
  relConfig: string,
): Promise<number | null> {
  if (!target) return null;
  try {
    // 寫前重讀並再次確認仍是乾淨 scaffold;若有人同時改過設定檔,寧可停下來重跑,
    // 也不要以舊判斷覆寫對方的資源命名。
    const fresh = await readFile(o.configPath, "utf8");
    const current = readWranglerConfig(fresh);
    if (siteConfigState(current) !== "fresh") {
      throw new ConfigShapeError("設定檔在確認後已變更,拒絕覆寫租戶命名;請重新執行 setup");
    }
    const { text, changed } = writeSiteResources(fresh, target);
    await writeFile(o.configPath, text, "utf8");
    o.reporter.step("ok", `更新 ${relConfig}`, changed.join("、"));
    return null;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    o.reporter.step("fail", `寫入 ${relConfig} 的租戶命名失敗`, detail);
    o.reporter.outro(["沒有建立任何 Cloudflare 資源;修正後可直接重跑 `sz-cms setup`。"]);
    return EXIT.SETUP_FAILED;
  }
}

/** 回填 id 到設定檔。回傳 null 代表成功;非 null 是要直接回傳的 exit code。 */
async function persistIds(
  o: SetupOptions,
  assignments: ReadonlyMap<string, string>,
  relConfig: string,
): Promise<number | null> {
  if (assignments.size === 0) return null;
  try {
    // **寫入前重讀**。偵測階段到現在之間,同一個 repo 可能有別人改過 main / triggers;
    // 用舊內容算出來的字元位移會落在錯的地方。重讀 + 重新解析,位移才是對的。
    const fresh = await readFile(o.configPath, "utf8");
    const { text, changed } = writeD1Ids(fresh, assignments);
    if (changed.length === 0) {
      o.reporter.step("skip", `${relConfig} 的 database_id 已正確,未改動`);
      return null;
    }
    await writeFile(o.configPath, text, "utf8");
    o.reporter.step("ok", `更新 ${relConfig}`, `database_id:${changed.join("、")}`);
    return null;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    o.reporter.step("fail", `寫入 ${relConfig} 失敗`, detail);
    o.reporter.note("請手動填入以下 database_id", [
      ...[...assignments].map(([name, uuid]) => `${name}: ${uuid}`),
    ]);
    o.reporter.outro(["填好之後重跑 `sz-cms setup`,已建立的資源會被偵測到並略過。"]);
    return EXIT.SETUP_FAILED;
  }
}

/** 確保 SECRETS_KEY 存在。回傳要附在收尾訊息裡的補充說明。 */
async function ensureSecretsKey(
  o: SetupOptions,
  generateSecret: () => string,
): Promise<string[]> {
  const { reporter: r } = o;
  const secrets = await r.task(`檢查 ${SECRETS_KEY}`, () => o.client.listSecrets());

  if (secrets === null) {
    // 最常見的原因是 Worker 還沒 deploy 過,帳號上根本沒有這個 Worker 可以掛 secret。
    // 這時候不能猜「沒設定」就硬寫,也不能說「已設定好」—— 誠實講清楚順序。
    r.step("warn", `查不到目前的 secret 清單`, "Worker 可能還沒 deploy 過。");
    return [
      `${SECRETS_KEY} 這一步留到部署之後(現在還沒有 Worker 可以掛 secret):`,
      "  pnpm deploy",
      `  openssl rand -base64 32 | pnpm exec wrangler secret put ${SECRETS_KEY}`,
      "",
      "⚠ 不要沿用 .dev.vars 裡的開發金鑰。加密信封沒有 key id,",
      "  之後換掉這把金鑰會讓所有既存的加密設定同時變成亂碼,且無漸進遷移路徑。",
    ];
  }

  if (secrets.includes(SECRETS_KEY)) {
    // 絕不覆寫。覆寫 = 所有已加密的設定同時報廢。
    r.step("ok", `${SECRETS_KEY} 已設定`, "不覆寫 —— 換金鑰會讓既存的加密設定全部失效。");
    return [];
  }

  if (!o.assumeYes) {
    const go = await o.prompter.confirm(
      `要現在產生並設定 ${SECRETS_KEY} 嗎?(32 byte 隨機值,不會顯示在畫面上)`,
      true,
    );
    if (!go) {
      r.step("skip", `略過 ${SECRETS_KEY}`);
      return [
        `記得設定 ${SECRETS_KEY},否則第一個「儲存加密設定」的動作就會失敗:`,
        `  openssl rand -base64 32 | pnpm exec wrangler secret put ${SECRETS_KEY}`,
      ];
    }
  }

  // 值走 stdin 進 wrangler,不進 argv、不印到畫面 —— argv 會被 ps 看到,也會留在 history。
  const outcome = await r.task(`設定 ${SECRETS_KEY}`, () =>
    o.client.putSecret(SECRETS_KEY, generateSecret()),
  );
  if (outcome.status === "failed") {
    r.step("fail", `設定 ${SECRETS_KEY} 失敗`, outcome.detail);
    return [
      `${SECRETS_KEY} 還沒設定好。部署之後手動補上:`,
      `  openssl rand -base64 32 | pnpm exec wrangler secret put ${SECRETS_KEY}`,
    ];
  }
  r.step("ok", `${SECRETS_KEY} 已產生並設定`, "值只存在 Cloudflare,本機沒有留副本。");
  return [];
}
