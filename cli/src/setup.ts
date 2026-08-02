// `sz-ws-cms setup` —— 從「本機跑得起來」到「線上跑得起來」的引導流程。
//
// 取代 DEPLOY.md 的手工步驟:建兩組 D1 + 兩組 R2、把回傳的 id 貼回 wrangler.jsonc、
// 套 migrations、設 SECRETS_KEY / AUTH_PEPPER / SETUP_TOKEN。
//
// 冪等性怎麼保證的:每一步都先「看帳號上有什麼」再決定要不要動作,而不是記錄自己做過什麼。
//   - 先把這份 repo 的 site slug 寫成唯一資源名稱;只有這個本地租戶邊界已驗證後,
//     D1 才用**名字**去 `wrangler d1 list` 找,找到就沿用它的 uuid,不會重建。
//   - R2 先 `r2 bucket info`;真的去建到已存在的 bucket 也被當成成功。
//   - wrangler.jsonc 的值已經對了就完全不產生編輯。
//   - migrations 本來就有 applied 紀錄表,重跑是 no-op。
//   - 三把 worker secret 已存在就跳過(**絕不覆寫** —— 換掉任一把都是不可逆的災難,
//     見 secrets.ts 的 MANAGED_SECRETS 說明)。
// 所以跑到一半斷掉的人,直接再跑一次就好。
//
// 第一次跑的時候 Worker 還不存在,三把金鑰**掛不上去**。那不再是這支指令的問題:
// `pnpm run deploy` 的 postdeploy hook 會跑 `sz-ws-cms secrets` 把缺的補齊。
// 這裡只負責在 Worker 已經存在時順手補上,並把「為什麼不能輪換」講清楚。

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EXIT } from "./exit.js";
import { displayWidth, padVisual, type Prompter, type Reporter } from "./ui.js";
import { WranglerClient } from "./wrangler.js";
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
import {
  AUTH_PEPPER,
  FIRST_ADMIN_TITLE,
  FIRST_ADMIN_WARNINGS,
  MANAGED_SECRETS,
  NO_ROTATION_TITLE,
  NO_ROTATION_WARNINGS,
  SECRETS_KEY,
  SETUP_TOKEN,
  defaultSecretGenerator,
  manualSecretCommands,
  type ManagedSecret,
} from "./secrets.js";

// 三把金鑰的定義只有一份,住在 secrets.ts(`sz-ws-cms secrets` 也要用同一份)。
// 這裡 re-export,`import { SECRETS_KEY } from "./setup.js"` 的既有契約不變。
export {
  SECRETS_KEY,
  AUTH_PEPPER,
  SETUP_TOKEN,
  defaultSecretGenerator,
} from "./secrets.js";

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
  /**
   * 真的有人在鍵盤前面(TTY 且未 --yes / --non-interactive)。
   * **不可以用 assumeYes 反推** —— stdin 被導向時 assumeYes 仍是 false,
   * 但那時的 prompter 是 auto 版,`select` 會直接回第一個選項。
   * 拿它去挑 Cloudflare 帳號就是靜默挑錯帳號、在別人的帳號上建資源。
   */
  interactive: boolean;
  skipMigrations: boolean;
  skipSecrets: boolean;
  /** 新 clone 的站點識別;非互動(CI)時必填。 */
  siteSlug?: string;
  /** 明知只部署一個站點的開發帳號才准用預設共用名稱。 */
  allowSharedDefaultNames?: boolean;
  /** 可注入,測試才能斷言「送進 secret put 的就是這個值」。 */
  generateSecret?: () => string;
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
    return "site slug must be 3–48 characters, lowercase alphanumeric/hyphen, no hyphens at start or end.";
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
      r.step("fail", `this repo is already configured for site slug "${config.siteSlug}", refusing to change to "${o.siteSlug}"`);
      r.outro(["if this is a different customer site, start with a clean scaffold clone, don't rename an existing site."]);
      return EXIT.SETUP_PREREQ;
    }
    r.step("ok", `site slug configured as "${config.siteSlug}", keeping existing resource names`);
    return { config, pending: null };
  }

  if (state === "unsafe") {
    r.step("fail", "wrangler.jsonc tenant naming incomplete or inconsistent");
    r.outro([
      "to prevent setup from guessing and taking over another site's resources, refusing to infer site slug from names.",
      "restore to clean scaffold and run with --site-slug <slug>, or manually make all six names match vars.CMS_SITE_SLUG.",
    ]);
    return EXIT.SETUP_PREREQ;
  }

  if (o.allowSharedDefaultNames) {
    if (o.siteSlug) {
      r.step("fail", "--allow-shared-default-names cannot be used with --site-slug");
      return EXIT.SETUP_PREREQ;
    }
    r.step("warn", "using shared default names", "only for single-site or dev accounts; multi-tenant accounts will cause cross-site access.");
    return { config, pending: null };
  }

  let slug = o.siteSlug;
  if (!slug) {
    if (o.assumeYes) {
      r.step("fail", "new scaffold clone still uses shared default names, site slug required");
      r.outro([
        "for CI / --yes: add sz-ws-cms setup --site-slug <lowercase-site-id> --yes",
        "shared names only work with: --allow-shared-default-names",
      ]);
      return EXIT.SETUP_PREREQ;
    }
    slug = await o.prompter.text("this is a new CMS site; enter site slug", "");
  }
  const invalid = validateSiteSlug(slug);
  if (invalid) {
    r.step("fail", `invalid site slug "${slug}"`, invalid);
    r.outro(["example: acme-taipei (no uppercase, underscores, dots, or leading/trailing hyphens)."]);
    return EXIT.SETUP_PREREQ;
  }

  const target = siteResourcesForSlug(slug);
  try {
    const preview = writeSiteResources(configText, target);
    r.step("todo", `site slug "${slug}" will be written to ${relConfig}`, "worker, self-reference, D1 pair, R2 pair all become site-specific names.");
    return { config: readWranglerConfig(preview.text), pending: target };
  } catch (e) {
    r.step("fail", `could not safely configure ${relConfig}`, e instanceof Error ? e.message : String(e));
    return EXIT.SETUP_PREREQ;
  }
}

/** 收尾的一個區塊 —— reporter.note(title, lines) 會印粗體標題 + 縮排內容。 */
interface NoteBlock {
  title: string;
  lines: string[];
}

interface NextStep {
  /** 要下的指令 / 要按的東西。這一欄會被對齊。 */
  action: string;
  /** 對齊後接在 `#` 後面的短說明。 */
  comment?: string;
  /** 補充行,縮在 action 底下。 */
  more?: readonly string[];
}

/**
 * 「接下來做什麼」。
 *
 * 刻意**沒有**「回頭再跑一次 setup 補金鑰」那一步了:三把金鑰現在由
 * `pnpm run deploy` 的 postdeploy hook(→ `sz-ws-cms secrets`)自動補上。
 * 那個往返是舊流程唯一存在的理由,拿掉之後這份清單才是真的線性的。
 */
function deployNextSteps(): string[] {
  const steps: readonly NextStep[] = [
    {
      // 一定要是 `pnpm run deploy`:`deploy` 是 pnpm 的內建指令,`pnpm deploy`
      // 會被它接走而不是跑 package.json 的 script(ERR_PNPM_CANNOT_DEPLOY)。
      action: "pnpm run deploy",
      comment: "build + deploy; postdeploy tops up any missing key",
    },
    {
      action: "open /setup on the live site",
      comment: `create the first admin, paste ${SETUP_TOKEN}`,
      more: ["(live D1 is empty, separate from local)"],
    },
    {
      action: "Settings → core.siteUrl",
      comment: "set it to your public URL",
      more: [
        "(OIDC redirect_uri, SEO canonical/sitemap/feed, payment return URLs all need absolute URLs)",
      ],
    },
    {
      action: "/admin/extensions",
      comment: "enable one extension, create content, check the public route",
    },
  ];

  // 對齊用 displayWidth/padVisual 而不是 .length:說明文字未來若含 CJK,
  // .length 會少算近一半欄數,整排就歪掉(見 ui.ts 的說明)。
  const width = Math.max(0, ...steps.map((s) => displayWidth(s.action)));
  const out: string[] = [];
  steps.forEach((step, i) => {
    const head = `${i + 1}. ${padVisual(step.action, width)}`;
    out.push(step.comment ? `${head}  # ${step.comment}` : head.trimEnd());
    // 補充行縮在 action 之下(`1. ` 是三欄),不跟著跑到註解欄。
    for (const line of step.more ?? []) out.push(`   ${line}`);
  });
  return out;
}

/** setup 成功時一定要印的兩段危險警告。內容住在 secrets.ts,兩支指令共用同一份。 */
function dangerBlocks(): NoteBlock[] {
  return [
    { title: FIRST_ADMIN_TITLE, lines: [...FIRST_ADMIN_WARNINGS] },
    { title: NO_ROTATION_TITLE, lines: [...NO_ROTATION_WARNINGS] },
  ];
}

export async function runSetup(o: SetupOptions): Promise<number> {
  const { reporter: r, prompter, client } = o;
  const generateSecret = o.generateSecret ?? defaultSecretGenerator;
  const relConfig = path.relative(o.cwd, o.configPath) || o.configPath;

  r.intro(
    "sz-ws-cms setup",
    o.dryRun
      ? "rehearsal mode: detect and list plan, create no resources, modify no files."
      : "connect this repo to your Cloudflare account.",
  );

  // ---- 1. 讀設定檔 ----
  let configText: string;
  try {
    configText = await readFile(o.configPath, "utf8");
  } catch (e) {
    r.step("fail", `could not read ${relConfig}`, e instanceof Error ? e.message : String(e));
    r.outro([
      "verify you are running `sz-ws-cms setup` from the CMS repo root,",
      "or use --config <path> to specify the wrangler config file.",
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
    r.step("fail", `failed to parse ${relConfig}`, detail);
    r.outro(["fix the config file format first, then rerun `sz-ws-cms setup`."]);
    return EXIT.SETUP_PREREQ;
  }

  if (config.d1.length === 0 && config.r2.length === 0) {
    r.step("warn", `${relConfig} has neither d1_databases nor r2_buckets`);
    r.outro(["no resources to create. if this is unexpected, verify config file contents."]);
    return EXIT.OK;
  }

  // ---- 1.5. 先鎖定本 clone 的租戶命名,絕不由帳號上既有名稱反推 ----
  const prepared = await prepareSiteConfig(o, configText, config, relConfig);
  if (typeof prepared === "number") return prepared;
  config = prepared.config;

  // ---- 2. 登入狀態 ----
  const who = await r.task("checking wrangler login status", () => client.whoami());
  if (!who.authenticated) {
    r.step("fail", "wrangler not logged in");
    r.outro([
      "log in first, then rerun:",
      "  pnpm exec wrangler login",
      "  sz-ws-cms setup",
      who.detail ? `\nwrangler said: ${who.detail}` : "",
    ].filter(Boolean));
    return EXIT.SETUP_PREREQ;
  }
  r.step("ok", `wrangler logged in${who.detail ? ` (${who.detail})` : ""}`);

  // ---- 3. 偵測現況 ----
  let d1List = await r.task("checking account D1 databases", () => client.listD1());

  // 多帳號是接案者/工作室的常態,而 wrangler 只在非互動模式報這個錯 —— 也就是
  // CI 與本 CLI。之前只印一段「請自己設 CLOUDFLARE_ACCOUNT_ID 再跑一次」,
  // 但清單就在錯誤訊息裡,叫使用者去複製貼上一個 32 位 hex 沒有道理。
  // 互動情境直接問他要哪一個,設進 process.env(子程序繼承)再重試一次。
  if (
    d1List?.dbs === null &&
    WranglerClient.isAccountAmbiguity(d1List?.detail ?? null)
  ) {
    const accounts = WranglerClient.parseAvailableAccounts(d1List.detail);
    if (accounts.length > 0 && o.interactive) {
      const picked = await prompter.select(
        "which Cloudflare account should this site live in?",
        accounts.map((a) => ({ label: a.name, value: a.id, hint: a.id })),
      );
      process.env.CLOUDFLARE_ACCOUNT_ID = picked;
      r.step("ok", "account selected", picked);
      d1List = await r.task("checking account D1 databases", () =>
        client.listD1(),
      );
    }
  }

  const accountDbs = d1List?.dbs ?? null;
  if (accountDbs === null) {
    const detail = d1List?.detail ?? null;
    r.step("fail", "could not read D1 list for account", detail ?? undefined);
    // 多帳號是最常見的原因,而且解法明確 —— 給指令,不要只丟原始訊息。
    const hint = WranglerClient.accountAmbiguityHint(detail);
    r.outro(
      hint ?? [
        "`wrangler d1 list --json` failed — without this list we cannot determine which resources exist,",
        "proceeding could create duplicate databases. verify network and account permissions, then rerun.",
        ...(detail ? ["", "wrangler message:", detail] : []),
      ],
    );
    return EXIT.SETUP_PREREQ;
  }

  const d1Plans = planD1(config, accountDbs);
  if (prepared.pending) {
    const collisions = d1Plans.filter((p) => p.existingUuid).map((p) => p.entry.databaseName);
    if (collisions.length > 0) {
      r.step("fail", "new scaffold will not claim existing D1 databases on account", collisions.join(", "));
      r.outro([
        "this means site slug is already in use or resources belong to another site. use a new --site-slug instead.",
        "to protect tenant data, existing resources are only reused when rerunning an existing repo with same slug.",
      ]);
      return EXIT.SETUP_PREREQ;
    }
  }
  for (const p of d1Plans) {
    if (p.existingUuid) {
      r.step(
        p.needsConfigWrite ? "todo" : "ok",
        `D1 ${p.entry.databaseName} (${p.entry.binding}) exists`,
        p.needsConfigWrite
          ? `config needs update to ${p.existingUuid}`
          : `config database_id is correct`,
      );
    } else {
      r.step("todo", `D1 ${p.entry.databaseName} (${p.entry.binding}) needs to be created`);
    }
  }

  const r2States = new Map<string, boolean | null>();
  for (const bucket of config.r2) {
    const exists = await r.task(`checking R2 ${bucket.bucketName}`, () =>
      client.r2Exists(bucket.bucketName),
    );
    r2States.set(bucket.bucketName, exists);
    if (exists === true) {
      r.step("ok", `R2 ${bucket.bucketName} (${bucket.binding}) exists`);
    } else if (exists === false) {
      r.step("todo", `R2 ${bucket.bucketName} (${bucket.binding}) needs to be created`);
    } else {
      r.step(
        "warn",
        `R2 ${bucket.bucketName} (${bucket.binding}) status unknown`,
        "will attempt creation; if it already exists, wrangler will report already exists and succeed.",
      );
    }
  }

  if (prepared.pending) {
    const collisions = [...r2States].filter(([, state]) => state !== false).map(([name]) => name);
    if (collisions.length > 0) {
      r.step(
        "fail",
        "new scaffold cannot confirm R2 names are unused",
        collisions.join(", "),
      );
      r.outro([
        "use a new --site-slug instead; also fix account permissions or network before trying to create or claim buckets.",
        "existing resources are only reused when rerunning an existing repo with same slug.",
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
    r.note("rehearsal results", [
      `create D1: ${willCreateD1}`,
      `create R2: ${willCreateR2}`,
      `update database_id in ${relConfig}: ${willWriteConfig} fields`,
      prepared.pending
        ? `set site slug: ${prepared.pending.siteSlug} (atomically updates 7 tenant fields)`
        : "set site slug: use existing config",
      o.skipMigrations
        ? "apply migrations: skipped (--skip-migrations)"
        : `apply migrations: ${migrationTargets.map((e) => e.databaseName).join(", ") || "(none)"}`,
      o.skipSecrets
        ? `set ${SECRETS_KEY} / ${AUTH_PEPPER}: skipped (--skip-secrets)`
        : `set ${SECRETS_KEY} / ${AUTH_PEPPER}: based on current state`,
    ]);
    r.outro(["rehearsal complete, nothing changed. remove --dry-run to actually proceed."]);
    return EXIT.OK;
  }

  if (willCreateD1 + willCreateR2 + willWriteConfig === 0) {
    r.step("ok", "resources and config are ready, nothing to create.");
  } else if (!o.assumeYes) {
    const go = await prompter.confirm(
      `create ${willCreateD1} D1 databases, ${willCreateR2} R2 buckets, and update ${relConfig}?`,
      true,
    );
    if (!go) {
      r.step("skip", "cancelled, no resources created, no files modified.");
      r.outro(["to preview what would happen: sz-ws-cms setup --dry-run"]);
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
    const created = await r.task(`creating D1 ${p.entry.databaseName}`, () =>
      client.createD1(p.entry.databaseName),
    );
    if (created.outcome.status === "failed") {
      r.step("fail", `failed to create D1 ${p.entry.databaseName}`, created.outcome.detail);
      failed = `failed to create D1 ${p.entry.databaseName}`;
      break;
    }
    if (created.uuid) {
      assignments.set(p.entry.databaseName, created.uuid);
      r.step("ok", `created D1 ${p.entry.databaseName}`, created.uuid);
    }
  }

  // 就算中途失敗也要把已經拿到的 id 寫回去 —— 不然下次重跑時設定檔仍是佔位值,
  // 使用者會以為什麼都沒成功。(重跑本身安全:D1 是用名字比對,不會建出第二個。)
  const configResult = await persistIds(o, assignments, relConfig);
  if (configResult !== null) return configResult;

  if (failed) {
    r.outro([`✗ ${failed}`, "fix the error above and rerun `sz-ws-cms setup` directly, completed steps will be skipped."]);
    return EXIT.SETUP_FAILED;
  }

  // ---- 6. 建 R2 ----
  for (const bucket of config.r2) {
    if (r2States.get(bucket.bucketName) === true) continue;
    const outcome = await r.task(`creating R2 ${bucket.bucketName}`, () =>
      client.createR2(bucket.bucketName),
    );
    if (outcome.status === "failed") {
      r.step("fail", `failed to create R2 ${bucket.bucketName}`, outcome.detail);
      r.outro([
        "fix the error above and rerun `sz-ws-cms setup`; already-created resources will be detected and skipped.",
      ]);
      return EXIT.SETUP_FAILED;
    }
    r.step("ok", `created R2 ${bucket.bucketName}`);
  }

  // ---- 7. migrations ----
  // 只對宣告了 migrations_dir 的 D1 跑。cms-tag-cache 沒有那個欄位,它的
  // revalidations 表由 opennextjs-cloudflare deploy 的 populate-cache 自己建
  // (schema 屬於 OpenNext,手抄一份進版控會漂移)。
  if (o.skipMigrations) {
    r.step("skip", "skipped migrations (--skip-migrations)");
  } else {
    for (const entry of migrationTargets) {
      const outcome = await r.task(`applying migrations to ${entry.databaseName}`, () =>
        client.applyMigrations(entry.databaseName),
      );
      if (outcome.status === "failed") {
        r.step("fail", `failed to apply migrations to ${entry.databaseName}`, outcome.detail);
        r.outro([
          "resources are created, only migrations failed. after fixing, run separately:",
          `  pnpm exec wrangler d1 migrations apply ${entry.databaseName} --remote`,
          "or rerun `sz-ws-cms setup` directly (completed steps will be skipped).",
        ]);
        return EXIT.SETUP_FAILED;
      }
      r.step("ok", `migrations applied to ${entry.databaseName}`);
    }
    for (const entry of config.d1) {
      if (!entry.hasMigrationsDir) {
        r.step(
          "skip",
          `${entry.databaseName} skipping migrations`,
          "config doesn't declare migrations_dir; tag cache tables are created by OpenNext on deploy.",
        );
      }
    }
  }

  // ---- 8. worker secrets ----
  let secretBlocks: NoteBlock[];
  if (o.skipSecrets) {
    r.step("skip", `skipped ${SECRETS_KEY} / ${AUTH_PEPPER} (--skip-secrets)`);
    secretBlocks = [
      {
        title: "you asked to skip the managed secrets — set them yourself",
        lines: [
          "`pnpm run deploy` normally does this for you (postdeploy → `sz-ws-cms secrets`).",
          "if you keep skipping, generate them once and never rotate them:",
          "",
          ...manualSecretCommands(),
          "",
          `${AUTH_PEPPER} must be set before opening /setup to create the first admin.`,
        ],
      },
    ];
  } else {
    secretBlocks = await ensureSecretsKey(o, generateSecret);
  }

  // 輸出分成有標題的區塊,而不是一大坨扁平的行:「接下來做什麼」跟「做錯會鎖死
  // 整站的警告」是兩種完全不同的東西,擠在同一段裡沒有人掃得到後者。
  r.note("next steps", deployNextSteps());
  for (const block of secretBlocks) r.note(block.title, block.lines);
  for (const block of dangerBlocks()) r.note(block.title, block.lines);
  r.outro(["✓ setup complete — run `pnpm run deploy` next."]);
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
      throw new ConfigShapeError("config was modified after confirmation, refusing to overwrite tenant names; rerun setup");
    }
    const { text, changed } = writeSiteResources(fresh, target);
    await writeFile(o.configPath, text, "utf8");
    o.reporter.step("ok", `updated ${relConfig}`, changed.join(", "));
    return null;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    o.reporter.step("fail", `failed to write tenant names to ${relConfig}`, detail);
    o.reporter.outro(["no Cloudflare resources created; after fixing, rerun `sz-ws-cms setup` directly."]);
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
      o.reporter.step("skip", `${relConfig} database_id already correct, no changes`);
      return null;
    }
    await writeFile(o.configPath, text, "utf8");
    o.reporter.step("ok", `updated ${relConfig}`, `database_id: ${changed.join(", ")}`);
    return null;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    o.reporter.step("fail", `failed to write to ${relConfig}`, detail);
    o.reporter.note("manually fill in these database_ids", [
      ...[...assignments].map(([name, uuid]) => `${name}: ${uuid}`),
    ]);
    o.reporter.outro(["after filling, rerun `sz-ws-cms setup`, created resources will be detected and skipped."]);
    return EXIT.SETUP_FAILED;
  }
}

/** 確保三把金鑰存在。回傳要附在收尾訊息裡的有標題區塊。 */
async function ensureSecretsKey(
  o: SetupOptions,
  generateSecret: () => string,
): Promise<NoteBlock[]> {
  const { reporter: r } = o;
  const names = MANAGED_SECRETS.map((s) => s.name).join(" / ");
  // 一次列舉,三把都用同一份清單判斷 —— 不必為了第二把再打一次 wrangler。
  const secrets = await r.task(`checking ${names}`, () => o.client.listSecrets());

  if (secrets === null) {
    // 最常見的原因是 Worker 還沒 deploy 過,帳號上根本沒有這個 Worker 可以掛 secret。
    // 這時候不能猜「沒設定」就硬寫,也不能說「已設定好」—— 誠實講清楚順序。
    //
    // 這**不再**是要使用者回頭重跑 setup 的理由:`pnpm run deploy` 的 postdeploy
    // hook 會在部署完成後自己跑 `sz-ws-cms secrets` 把缺的補上。openssl 那幾行
    // 降級成「萬一自動那步也失敗」時的備援,不是主要路徑。
    r.step(
      "warn",
      "could not retrieve secret list",
      "worker may not be deployed yet — normal on a first setup, and nothing to fix here.",
    );
    return [
      {
        title: `${names} will be set right after the first deploy`,
        lines: [
          "no worker exists yet, so there is nothing to attach secrets to. `pnpm run deploy`",
          "runs the postdeploy hook (`sz-ws-cms secrets`), which generates the missing ones",
          `and prints the ${SETUP_TOKEN} value once.`,
        ],
      },
      {
        title: "fallback — only if that automatic step fails",
        lines: [
          ...manualSecretCommands(),
          "",
          `you would then have to remember the ${SETUP_TOKEN} value yourself: wrangler cannot`,
          "read a secret back after it is set.",
        ],
      },
    ];
  }

  const blocks: NoteBlock[] = [];
  for (const spec of MANAGED_SECRETS) {
    blocks.push(...(await ensureOneSecret(o, spec, secrets, generateSecret)));
  }
  return blocks;
}

/** 單一把 secret 的「有就跳過、沒有就產生」。絕不覆寫。 */
async function ensureOneSecret(
  o: SetupOptions,
  spec: ManagedSecret,
  existing: readonly string[],
  generateSecret: () => string,
): Promise<NoteBlock[]> {
  const { reporter: r } = o;
  const { name } = spec;

  if (existing.includes(name)) {
    r.step("ok", `${name} already set`, spec.neverRotate);
    return [];
  }

  if (!o.assumeYes) {
    const go = await o.prompter.confirm(
      `generate and set ${name} now? (${spec.why}; 32-byte random, not shown on screen)`,
      true,
    );
    if (!go) {
      r.step("skip", `skipped ${name}`);
      return [
        {
          title: `${name} is still unset`,
          lines: [spec.why, "", ...manualSecretCommands([name])],
        },
      ];
    }
  }

  // 值走 stdin 進 wrangler,不進 argv、不印到畫面 —— argv 會被 ps 看到,也會留在 history。
  const value = generateSecret();
  const outcome = await r.task(`setting ${name}`, () => o.client.putSecret(name, value));
  if (outcome.status === "failed") {
    r.step("fail", `failed to set ${name}`, outcome.detail);
    return [
      {
        title: `${name} could not be set`,
        lines: [
          "`pnpm run deploy` will try again via the postdeploy hook. to do it by hand:",
          "",
          ...manualSecretCommands([name]),
        ],
      },
    ];
  }

  const reveal = spec.reveal === true;
  r.step(
    "ok",
    `${name} generated and set`,
    reveal ? "value will be printed below — only once." : "value exists only on Cloudflare, no local copy.",
  );
  if (!reveal) return [];

  // 這一把非印不可:CLI 不會替使用者開瀏覽器填表,而 wrangler 事後也讀不回
  // secret 的值。不印 = 使用者永遠建不出第一個管理員,只能自己覆寫一把。
  return [
    {
      title: `${name} — copy it now, it cannot be shown again`,
      lines: [
        value,
        "",
        "paste it into the /setup form when creating the first admin; it stops working after that.",
      ],
    },
  ];
}
