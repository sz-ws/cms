import type { DeclarativeField } from "../../manifest";

// core-v2 §3.5:grid card anatomy 從 content type 的 field defs *推斷*,零額外設定。
//   cover = 第一個 media 欄(缺 → 無圖,text-only card)
//   title = slugField 指向的欄,否則第一個 text 欄,否則第一個欄
//   badge = status(entry 內建,不從 field 推)
//   meta  = 第一個 select,否則第一個 date 欄
// 純函式、無 I/O、可單測。view 端只讀結果,不重算。

export interface CardConfig {
  /** 封面圖 media 欄 key;無 media 欄則 null(text-only card)。 */
  coverKey: string | null;
  /** 標題欄 key(必有 —— 至少回退到第一欄)。 */
  titleKey: string;
  /** meta 行的欄位(select 優先,否則 date);無則 null。 */
  metaField: DeclarativeField | null;
}

/**
 * 從 field 陣列與 slugField 推斷卡片組成。fields 為空時 titleKey 回空字串
 * (呼叫端應以 entry.id fallback)。
 */
export function inferCardConfig(
  fields: readonly DeclarativeField[],
  slugField: string | undefined,
): CardConfig {
  const coverField = fields.find((f) => f.type === "media") ?? null;

  const titleField =
    fields.find((f) => f.key === slugField && f.type === "text") ??
    fields.find((f) => f.type === "text") ??
    fields[0];

  const metaField =
    fields.find((f) => f.type === "select") ??
    fields.find((f) => f.type === "date") ??
    null;

  return {
    coverKey: coverField ? coverField.key : null,
    titleKey: titleField ? titleField.key : "",
    metaField,
  };
}
