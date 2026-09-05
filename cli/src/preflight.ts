// `sz-ws-cms preflight` —— deploy 之前把「還沒填的東西」一次列出來。
//
// 唯讀。掃 extensions 底下每個 manifest.json 的 settings[],逐項判定:
//
//   非 secret  → 查 wrangler.jsonc 的 vars
//   secret     → 查 `wrangler secret list`(唯讀,dry-run 也照跑)
//
// 輸出刻意分成**三區**,而不是一個「全綠 / 有紅」的總結:
//
//   verified                     這一項確實已經有值
//   missing                      必填、而且明確查得出來是空的        ← --gate 擋這個
//   cannot verify before deploy  查不到,而查不到不等於沒設定
//
// 第三區是這支指令存在的理由。extension 的設定最終落在 D1 的 settings 表(deploy 後
// 在 admin 填),CLI 在 deploy 前根本連不到那張表 —— 沒有這一區的話,一個什麼都沒
// 設定的站台會印出滿江綠,而那正是最危險的假訊號。
//
// 未登入 Cloudflare 時**不失敗**:`wrangler secret list` 查不到就降級成「無法驗證」
// 繼續跑完。理由見 gateVerdict() 的說明 —— 第一次 deploy 時 Worker 還不存在,
// 那條查詢必定失敗,拿它擋 deploy 會讓人永遠 deploy 不出第一版。

import { readFile } from "node:fs/promises";
import path from "node:path";
import { EXIT } from "./exit.js";
import {
  collectAllSettings,
  envKeyFor,
  storageFor,
  type SettingField,
  type SettingStorage,
} from "./settings.js";
import { displayWidth, padVisual, type Reporter } from "./ui.js";
import { readVars } from "./wrangler-config.js";
import type { WranglerClient } from "./wrangler.js";

export type PreflightVerdict = "ok" | "missing" | "unverifiable";

export interface PreflightRow {
  extId: string;
  key: string;
  envKey: string;
  label: string;
  required: boolean;
  storage: SettingStorage;
  verdict: PreflightVerdict;
  /** 給人看的一句話,講清楚「為什麼是這個判定」。 */
  reason: string;
}

export interface PreflightOptions {
  /** extensions/ 的絕對路徑。 */
  extensionsDir: string;
  /** wrangler.jsonc 的絕對路徑。 */
  configPath: string;
  client: WranglerClient;
  reporter: Reporter;
  /** true → 有 missing 就非零退出(predeploy 用)。 */
  gate: boolean;
  /** 由 `cms deploy` 呼叫;標題印成它的一個階段而不是另一支指令。 */
  managedDeploy?: boolean;
}

export interface PreflightReport {
  rows: PreflightRow[];
  /** false = `wrangler secret list` 查不到(未登入 / Worker 尚未存在)。 */
  secretsReadable: boolean;
  /** manifest 讀取層級的錯誤;不中斷,但要印出來。 */
  errors: string[];
}

/** vars 裡「有值」的判定:鍵存在,而且不是空字串 / null。 */
export function varIsSet(vars: ReadonlyMap<string, unknown>, envKey: string): boolean {
  if (!vars.has(envKey)) return false;
  const value = vars.get(envKey);
  if (value === null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

/** 純函式的判定核心 —— 測試不需要碰檔案系統或 wrangler。 */
export function judge(
  extId: string,
  field: SettingField,
  vars: ReadonlyMap<string, unknown>,
  secretNames: readonly string[] | null,
): PreflightRow {
  const envKey = envKeyFor(extId, field.key);
  const storage = storageFor(field);
  const base = {
    extId,
    key: field.key,
    envKey,
    label: field.label,
    required: field.required,
    storage,
  } as const;

  if (storage === "vars") {
    if (varIsSet(vars, envKey)) {
      return { ...base, verdict: "ok", reason: "set in wrangler.jsonc vars" };
    }
    if (field.required) {
      return { ...base, verdict: "missing", reason: "required, not in wrangler.jsonc vars" };
    }
    return {
      ...base,
      verdict: "unverifiable",
      reason: "optional and not in vars — may be filled in admin → Settings after deploy",
    };
  }

  if (secretNames === null) {
    // 查不到 ≠ 沒設定。這條分支是「未登入 / Worker 尚未 deploy」時的降級路徑。
    return {
      ...base,
      verdict: "unverifiable",
      reason: "could not query `wrangler secret list` (not logged in, or Worker not deployed yet)",
    };
  }
  if (secretNames.includes(envKey)) {
    return { ...base, verdict: "ok", reason: "set as a Worker secret" };
  }
  if (field.required) {
    return { ...base, verdict: "missing", reason: "required secret, not set on the Worker" };
  }
  return {
    ...base,
    verdict: "unverifiable",
    reason: "optional secret, not set — may be filled in admin → Settings after deploy",
  };
}

/**
 * `--gate` 的退出碼。
 *
 * 只有 **missing**(明確查得出來是空的必填項)會擋。必填 secret 因為「查不到」而落在
 * unverifiable 的**不擋** —— 第一次 deploy 時帳號上還沒有這個 Worker,`wrangler
 * secret list` 必定失敗;拿它擋下去,使用者會卡在一個永遠過不了的關卡:要有 secret
 * 得先有 Worker,要有 Worker 得先 deploy,而 deploy 被這道 gate 擋著。
 * 所以那一類改成「大聲警告 + 明講是查不到而不是缺」,並在輸出裡給出補設的指令。
 */
export function gateVerdict(rows: readonly PreflightRow[]): number {
  return rows.some((row) => row.verdict === "missing")
    ? EXIT.PREFLIGHT_BLOCKED
    : EXIT.OK;
}

/** 對齊用:標籤欄以**終端欄寬**取最大值,CJK 一個字算兩欄(見 ui.ts:displayWidth)。 */
function renderRows(rows: readonly PreflightRow[]): string[] {
  const labelWidth = Math.max(0, ...rows.map((row) => displayWidth(row.label)));
  const keyWidth = Math.max(0, ...rows.map((row) => displayWidth(row.envKey)));
  return rows.map(
    (row) =>
      `${padVisual(row.label, labelWidth)}  ${padVisual(row.envKey, keyWidth)}  ${row.reason}`,
  );
}

export async function collectPreflight(
  o: Pick<PreflightOptions, "extensionsDir" | "configPath" | "client">,
): Promise<PreflightReport> {
  const { extensions, errors } = await collectAllSettings(o.extensionsDir);

  let vars = new Map<string, unknown>();
  try {
    vars = readVars(await readFile(o.configPath, "utf8"));
  } catch (e) {
    errors.push(
      `could not read ${path.basename(o.configPath)}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const needsSecrets = extensions.some((ext) => ext.settings.some((f) => f.secret));
  // 唯讀查詢,dry-run 下照跑(見 wrangler.ts 檔頭的讀寫分界)。沒有 secret 型設定
  // 就完全不打這通 —— 沒必要為了一份不會用到的清單去要求登入。
  const secretNames = needsSecrets ? await o.client.listSecrets() : [];

  const rows: PreflightRow[] = [];
  for (const ext of extensions) {
    for (const note of ext.skipped) errors.push(`${ext.extId}: ${note}`);
    for (const field of ext.settings) {
      rows.push(judge(ext.extId, field, vars, secretNames));
    }
  }

  return { rows, secretsReadable: secretNames !== null, errors };
}

export async function runPreflight(o: PreflightOptions): Promise<number> {
  const { reporter: r } = o;
  r.intro(
    o.managedDeploy ? "cms deploy · settings check" : "sz-ws-cms preflight",
    o.gate ? "deploy gate: missing required settings will stop the deploy." : "read-only check of extension settings.",
  );

  const report = await collectPreflight(o);
  for (const message of report.errors) r.step("warn", message);

  if (report.rows.length === 0) {
    r.step("skip", "no extension declares settings[] in extensions/*/manifest.json");
    r.outro([
      "nothing to check. note this only covers manifest-declared settings —",
      "code extensions without a manifest.json are invisible to preflight.",
    ]);
    return EXIT.OK;
  }

  const ok = report.rows.filter((row) => row.verdict === "ok");
  const missing = report.rows.filter((row) => row.verdict === "missing");
  const unverifiable = report.rows.filter((row) => row.verdict === "unverifiable");

  if (ok.length > 0) r.note(`verified (${ok.length})`, renderRows(ok));
  if (missing.length > 0) r.note(`missing — required (${missing.length})`, renderRows(missing));
  if (unverifiable.length > 0) {
    r.note(`cannot be verified before deploy (${unverifiable.length})`, [
      ...renderRows(unverifiable),
      "",
      "these are NOT confirmed as set. extension settings ultimately live in the D1 settings",
      "table — fill them in admin → Extensions → Settings after deploying, then check there.",
    ]);
  }

  const requiredUnverifiableSecrets = unverifiable.filter(
    (row) => row.required && row.storage === "secret",
  );
  if (!report.secretsReadable) {
    r.step(
      "warn",
      "could not read the Worker secret list — secret checks were skipped, not passed",
      "usual causes: not logged in (`pnpm exec wrangler login`), or the Worker has never been deployed.",
    );
  }
  if (requiredUnverifiableSecrets.length > 0) {
    r.step(
      "warn",
      `${requiredUnverifiableSecrets.length} required secrets could not be verified`,
      "not blocking: on a first deploy the Worker does not exist yet, so this query always fails.",
    );
    r.note("set them right after the deploy finishes", [
      ...requiredUnverifiableSecrets.map((row) => `  pnpm exec wrangler secret put ${row.envKey}`),
    ]);
  }

  const code = o.gate ? gateVerdict(report.rows) : EXIT.OK;
  if (code !== EXIT.OK) {
    r.outro([
      `✗ ${missing.length} required settings are missing — deploy stopped.`,
      "fill them in, then rerun. non-secret values go to the `vars` block in wrangler.jsonc:",
      ...missing
        .filter((row) => row.storage === "vars")
        .map((row) => `  "${row.envKey}": "…"`),
      ...(missing.some((row) => row.storage === "secret")
        ? [
            "secrets go to Cloudflare (never into wrangler.jsonc — that file is committed):",
            ...missing
              .filter((row) => row.storage === "secret")
              .map((row) => `  pnpm exec wrangler secret put ${row.envKey}`),
          ]
        : []),
      "",
      "to deploy anyway, run the deploy command directly (this gate only runs from `pnpm run deploy`).",
    ]);
    return code;
  }

  r.outro([
    missing.length === 0 && unverifiable.length === 0
      ? "✓ all declared settings are set."
      : `✓ nothing blocking. ${unverifiable.length} settings still need checking in admin after deploy.`,
  ]);
  return EXIT.OK;
}
