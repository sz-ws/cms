// 外掛設定的判定核心(`cms doctor`、`cms deploy` 與舊名 `cms preflight` 共用)。
//
// 每一項設定落在三種判定之一:
//
//   ok            確實已經有值
//   missing       必填、而且明確查得出來是空的        ← 擋部署的只有這一種
//   unverifiable  查不到,而查不到不等於沒設定
//
// 非 secret 查 wrangler.jsonc 的 vars;secret 查 Worker 的 secret 名稱清單。清單讀不到
// (未登入、Worker 還沒部署)時 secret 一律是 unverifiable:第一次部署時 Worker 還不存在,
// 拿「查不到」去擋部署,會讓人永遠部署不出第一版。

import {
  envKeyFor,
  storageFor,
  type SettingField,
  type SettingStorage,
} from "./settings.js";

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
      reason: "the Worker's secret names could not be read (not signed in, or not deployed yet)",
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
