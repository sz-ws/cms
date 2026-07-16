import type { DeclarativeContentType } from "./manifest";
import { resolveLocalizedString } from "@/lib/i18n/localized";

// A(docs/spec-declarative-notify-schedule.md):public create 成功後的
// best-effort 通知信。純文字信件,不做 HTML 模板。
//
// workers pool 地雷:crud.ts(本模組的唯一呼叫端)被測試靜態 import;`@/lib/email`
// 的相依鏈經 buildProviderRegistry → loader,`@/lib/settings` 亦透過
// secretKeySetAsync/allowedSettingKeys dynamic import loader —— 兩者都在此函式內
// dynamic import,絕不讓 crud.ts 的靜態 import 圖碰到 loader/services 鏈
// (同 crud.ts 既有 provider()/readJson() 慣例)。

const FIELD_VALUE_MAX_CHARS = 500; // spec:每值截斷 500 字元。

function formatFieldValue(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > FIELD_VALUE_MAX_CHARS
    ? s.slice(0, FIELD_VALUE_MAX_CHARS)
    : s;
}

/** payload 逐欄位 `key: value` 行(payload 已經 sanitizePublicCreateBody 處理過,
 * 不含 honeypot 與保留鍵)。 */
function buildBody(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .map(([key, value]) => `${key}: ${formatFieldValue(value)}`)
    .join("\n");
}

/**
 * public create 成功、回 201 之前呼叫。best-effort:整段 try/catch,任何失敗只
 * console.error,絕不影響呼叫端的 201(同 FTS 索引哲學)。
 *
 * 跳過條件(spec):`ct.public` 非 true、`ct.notifyOnCreate` 非 true、或
 * `core.notifyEmail` 設定為空 —— 皆靜默跳過,不寄信。
 */
export async function notifyOnPublicCreate(
  ct: DeclarativeContentType,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!ct.public || ct.notifyOnCreate !== true) return;
  try {
    const { getSetting } = await import("@/lib/settings");
    const to = await getSetting<string>("core.notifyEmail", "");
    if (!to) return;

    const { sendEmail } = await import("@/lib/email");
    const siteTitle = await getSetting<string>("core.siteTitle", "");
    // §1 #3:type label 可為 LocalizedString;通知信依站台 core.locale resolve
    // (物件直接內插會變成 "[object Object]")。
    const localeRaw = await getSetting<string>("core.locale", "en");
    const locale = localeRaw === "zh-Hant" ? "zh-Hant" : "en";
    const label = resolveLocalizedString(ct.label, locale) ?? ct.name;
    const subject = siteTitle
      ? `${siteTitle}: New ${label} submission`
      : `New ${label} submission`;

    const result = await sendEmail({ to, subject, text: buildBody(payload) });
    // sendEmail 失敗回 { ok:false }(不 throw)—— 不留痕會讓「有設定卻沒收到信」
    // 完全無法診斷,故 non-ok 一律 console.error(仍不影響呼叫端 201)。
    if (!result.ok) {
      console.error(
        "[dx:notify] notifyOnCreate send failed",
        ct.name,
        result.error,
      );
    }
  } catch (e) {
    console.error("[dx:notify] notifyOnCreate failed", ct.name, e);
  }
}
