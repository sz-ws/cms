// installPrompts 驗證(純函式,無 I/O)——install route 在寫入 DB 之前呼叫此
// helper,把使用者於「安裝表單」填的值收斂成型別正確、只含已宣告 key 的
// Record<string, unknown>。manifest zod 層已保證每個 prompt.key 對應一個
// settings[].key(見 manifest.ts superRefine);此處只管「這次安裝提交的值」
// 是否符合各 prompt 的 required / type 規則。

import type { DeclarativeManifest } from "./manifest";

export type InstallPrompt = NonNullable<DeclarativeManifest["installPrompts"]>[number];

export type ValidatePromptValuesResult =
  | { ok: true; values: Record<string, unknown> }
  | {
      ok: false;
      error: "invalid_prompt_values" | "missing_prompt_values";
      fields: string[];
    };

/**
 * 驗證 install 表單提交的 promptValues 是否符合 manifest.installPrompts 的宣告:
 *   - 出現不在 prompts 清單裡的 key → invalid_prompt_values
 *   - 缺少任一 required prompt(或 required text/textarea 收到空字串)→ missing_prompt_values
 *   - 型別不符(text/textarea 非 string、number 非有限數字、boolean 非布林)→ invalid_prompt_values
 * 成功時只回傳「有出現在輸入裡」的 key(未填的 optional prompt 不補進 values ——
 * 呼叫端沿用原本的 default-value 寫入路徑)。
 */
export function validatePromptValues(
  prompts: readonly InstallPrompt[] | undefined,
  values: Record<string, unknown> | undefined,
): ValidatePromptValuesResult {
  const promptList = prompts ?? [];
  const input = values ?? {};
  const promptsByKey = new Map(promptList.map((p) => [p.key, p]));

  const unknownKeys = Object.keys(input).filter((k) => !promptsByKey.has(k));
  if (unknownKeys.length > 0) {
    return { ok: false, error: "invalid_prompt_values", fields: unknownKeys };
  }

  const missing: string[] = [];
  const invalid: string[] = [];
  const out: Record<string, unknown> = {};

  for (const prompt of promptList) {
    const hasValue = Object.prototype.hasOwnProperty.call(input, prompt.key);
    const raw = input[prompt.key];

    // required 缺失:未提供,或(text/textarea)提供了空字串。
    const isEmptyString =
      (prompt.type === "text" || prompt.type === "textarea") &&
      typeof raw === "string" &&
      raw.trim().length === 0;
    if (prompt.required && (!hasValue || isEmptyString)) {
      missing.push(prompt.key);
      continue;
    }

    if (!hasValue) continue; // optional + 未提供 → 不寫入,呼叫端走 default

    switch (prompt.type) {
      case "text":
      case "textarea":
        if (typeof raw !== "string") {
          invalid.push(prompt.key);
          continue;
        }
        break;
      case "number":
        if (typeof raw !== "number" || !Number.isFinite(raw)) {
          invalid.push(prompt.key);
          continue;
        }
        break;
      case "boolean":
        if (typeof raw !== "boolean") {
          invalid.push(prompt.key);
          continue;
        }
        break;
    }

    out[prompt.key] = raw;
  }

  if (missing.length > 0) {
    return { ok: false, error: "missing_prompt_values", fields: missing };
  }
  if (invalid.length > 0) {
    return { ok: false, error: "invalid_prompt_values", fields: invalid };
  }

  return { ok: true, values: out };
}
