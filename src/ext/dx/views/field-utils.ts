import type { DeclarativeBlockDef, DeclarativeField } from "../manifest";
import { richtextToPlainText } from "../fields/richtext-schema";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import type { Locale } from "@/lib/i18n/index";

// generic views 共用的欄位格式化。純函式,無 I/O。

// spec-extension-i18n.md #4–#7:label 由 plain string 擴成 LocalizedString。fieldLabel /
// blockLabel 是「單一 resolve 點」——所有 view / field control 一律經由此處把 label
// resolve 成當前 locale 的顯示字串(缺 label 時退回機器 key/name,永不露空)。locale 由
// 呼叫端提供:server component 走 getLocale();client field tree 走 ExtLocaleProvider。
export function fieldLabel(
  field: Pick<DeclarativeField, "label" | "key">,
  locale: Locale,
): string {
  return resolveLocalizedString(field.label, locale) ?? field.key;
}

/** blocks 的具名 block 顯示 label(spec §1 #7):resolve 後退回 block name。 */
export function blockLabel(
  def: Pick<DeclarativeBlockDef, "label" | "name">,
  locale: Locale,
): string {
  return resolveLocalizedString(def.label, locale) ?? def.name;
}

/**
 * 08 §2:某 content type 的「標題欄位」——關聯 picker、cell、detail 用它把 entry
 * 顯示成人類可讀的一句話。策略同 DetailView / selectColumns:slugField 指向的欄位
 * 優先,否則第一個 text 欄位,否則第一個欄位。無欄位 → undefined。
 */
export function pickTitleField(
  fields: readonly DeclarativeField[],
  slugField: string | undefined,
): DeclarativeField | undefined {
  if (fields.length === 0) return undefined;
  return (
    fields.find((f) => f.key === slugField) ??
    fields.find((f) => f.type === "text") ??
    fields[0]
  );
}

// ---- 欄位能力分類 ----

/** 可排序的 field type(json_extract 上為純量,序有意義)。 */
const SORTABLE_TYPES = new Set<DeclarativeField["type"]>([
  "text",
  "number",
  "date",
  "select",
  "slug",
  "boolean",
]);

export function isSortable(field: DeclarativeField): boolean {
  return SORTABLE_TYPES.has(field.type);
}

/** 適合放進 collection 表格的欄位型別(排除撐版面 / 無意義的)。 */
const COLUMN_TYPES = new Set<DeclarativeField["type"]>([
  "text",
  "slug",
  "number",
  "boolean",
  "date",
  "select",
  "media",
  // 08 §1:relation(單標題)與 relations(壓縮成「首標題 +N」)都可入表;
  // cell 由 RelationCell 客端解析 id → title(見 cell-renderers.tsx 的 N+1 caveat)。
  "relation",
  "relations",
]);

/**
 * 為 collection 表格挑選預設欄位。策略:
 *   1. 標題欄(slugField 指向的 text 欄,否則第一個 text 欄,否則第一個欄)永遠第一。
 *   2. 依序補入其餘「適合入表」的欄位(text/slug/number/boolean/date/select/media),
 *      跳過 richtext/json(撐版或無意義),直到達上限。
 * status 與 updatedAt 由 view 另行固定加在尾端,不在此列。
 */
export function selectColumns(
  fields: DeclarativeField[],
  slugField: string | undefined,
  max = 5,
): DeclarativeField[] {
  if (fields.length === 0) return [];
  const titleField =
    fields.find((f) => f.key === slugField && f.type === "text") ??
    fields.find((f) => f.type === "text") ??
    fields[0];

  const rest = fields.filter(
    (f) => f.key !== titleField.key && COLUMN_TYPES.has(f.type),
  );
  return [titleField, ...rest].slice(0, max);
}

/** 日期(epoch ms)→ yyyy-mm-dd。非數字回空字串。 */
export function fmtDate(v: unknown): string {
  const n = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(n)) return "";
  return new Date(n).toISOString().slice(0, 10);
}

/** 依欄位型別把 data 值格式化為表格 cell / detail 顯示用的字串。 */
export function displayValue(field: DeclarativeField, value: unknown): string {
  if (value === undefined || value === null) return "";
  switch (field.type) {
    case "date":
      return fmtDate(value);
    case "boolean":
      return value ? "yes" : "no";
    case "json":
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    case "richtext":
      // C.5b: richtext is now a Tiptap JSON doc (or legacy string). Flatten to
      // plain text for table cells / list labels — String() would yield
      // "[object Object]".
      return richtextToPlainText(value);
    case "relation":
      // 08 §1: raw stored value is an entry id. This is the fallback label only
      // (RelationCell / DetailView resolve id → title for real display).
      return typeof value === "string" ? value : "";
    case "relations":
      // 08 §1: ordered id array; fallback label is the count of linked entries.
      return Array.isArray(value) ? `${value.length} linked` : "";
    case "text":
    case "slug":
    case "media":
    case "select":
    case "number":
      return String(value);
    default:
      return String(value);
  }
}

/** 表格 cell 內容截斷(避免過長 richtext 撐破版面)。 */
export function truncate(s: string, max = 80): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
