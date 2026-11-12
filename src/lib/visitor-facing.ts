import { publicContentChanged } from "./public-cache";
import type { Extension } from "../ext/types";

// [core] 2.0 頁面快取:哪些東西「訪客看得到依賴它的輸出」(visitorFacing),以及唯一的一條規則:
// 寫到一個帶著這個記號的東西,存起來的公開頁全部重算(publicContentChanged)。
//
// 記號是中性的,只說「訪客看得到依賴它的輸出」,由擁有那個東西的一方自己標:core 標自己的設定、
// 檔案區,插件標自己的。五種東西,各自的寫法與預設值:
//
//   content    內容類型        ContentTypeDef / contentTypes[].visitorFacing        預設 true
//   setting    設定欄位        SettingField.visitorFacing(宣告過的欄位)           預設 true
//                              沒宣告的 key(程式自己記的帳)                        預設 false
//   table      資料表          Extension.visitorFacingTables                        預設 false
//   files      檔案區(key 的第一段:core、avatars、插件 id)Extension.visitorFacingFiles 預設 false
//   extension  插件本身(安裝、啟用、停用、移除、script 核准)Extension.visitorFacing 預設 true
//
// 人在後台編的東西預設 true(標 false 退出);程式寫的東西預設 false(標 true 加入)。
// 寫入的最底層(setSettings、deleteFile、content provider、ledger-kit 的交易、插件管理)
// 寫完呼叫 wrote(kind, name) 一次;要不要重算只在這裡決定。不經這些底層的寫入
// (插件用 services.db 直接寫、外部狀態)寫完自己呼叫 services.publicContentChanged。

export type VisitorFacingKind = "content" | "setting" | "table" | "files" | "extension";

const KIND_DEFAULT: Record<VisitorFacingKind, boolean> = {
  content: true,
  setting: false,
  table: false,
  files: false,
  extension: true,
};

interface Declaration {
  kind: VisitorFacingKind;
  /** 定義者給的預設(例如 commerce-kit 定義的訂單表),使用它的插件的宣告蓋得過。 */
  fallback: boolean;
  marks: ReadonlyMap<string, boolean>;
}

const declarations = new Map<string, Declaration>();

/**
 * 宣告一批記號。同一個 source + kind 再宣告一次就整批取代(loader 每次建 runtime 重宣告插件的)。
 * `fallback`:定義者的預設,只在沒有別人宣告這個名字時才用。
 */
export function declareVisitorFacing(
  source: string,
  kind: VisitorFacingKind,
  entries: Iterable<readonly [string, boolean]>,
  opts: { fallback?: boolean } = {},
): void {
  declarations.set(`${kind}\u0000${source}`, {
    kind,
    fallback: opts.fallback === true,
    marks: new Map(entries),
  });
}

export function isVisitorFacing(kind: VisitorFacingKind, name: string): boolean {
  let fallback: boolean | undefined;
  for (const d of declarations.values()) {
    if (d.kind !== kind) continue;
    const mark = d.marks.get(name);
    if (mark === undefined) continue;
    if (!d.fallback) return mark;
    fallback ??= mark;
  }
  return fallback ?? KIND_DEFAULT[kind];
}

/**
 * 唯一的規則:寫入成立之後呼叫。寫到的東西有任何一個帶著記號,存起來的公開頁全部重算。
 * `rows` 給有「這一列訪客看不看得到」的東西(內容:已發佈):寫入前後都看不到的列不算。
 * 永不 throw(publicContentChanged 也不 throw)。
 */
export function wrote(
  kind: VisitorFacingKind,
  names: string | readonly string[],
  rows?: { before: boolean; after: boolean },
): void {
  if (rows && !rows.before && !rows.after) return;
  const list = typeof names === "string" ? [names] : names;
  const hits = [...new Set(list)].filter((name) => isVisitorFacing(kind, name));
  if (hits.length > 0) publicContentChanged(`${kind}:${hits.join(",")}`);
}

/** Extension.visitorFacingTables 的兩種寫法:名字清單(= true),或 { 表名: true | false }。 */
function tableMarks(ext: Extension): [string, boolean][] {
  const tables = ext.visitorFacingTables;
  if (!tables) return [];
  return Array.isArray(tables) ? tables.map((t) => [t, true]) : Object.entries(tables);
}

/**
 * loader 每次建 runtime 時呼叫:插件宣告的記號。`known` 是裝著的全部(停用、移除那一刻也查得到
 * 它的 visitorFacing),`enabled` 是啟用中的(設定、表、內容類型、檔案區只算啟用中的)。
 * 設定欄位的 key 由呼叫端換成存進 D1 的完整 key。
 */
export function declareExtensionsVisitorFacing(
  known: readonly Extension[],
  enabled: readonly Extension[],
  settingKey: (extId: string, key: string) => string,
): void {
  declareVisitorFacing(
    "extensions",
    "extension",
    known.flatMap((ext) => (ext.visitorFacing === undefined ? [] : [[ext.id, ext.visitorFacing] as const])),
  );
  declareVisitorFacing(
    "extensions",
    "setting",
    enabled.flatMap((ext) =>
      (ext.settings ?? []).map((f) => [settingKey(ext.id, f.key), f.visitorFacing ?? true] as const),
    ),
  );
  declareVisitorFacing("extensions", "table", enabled.flatMap(tableMarks));
  declareVisitorFacing(
    "extensions",
    "content",
    enabled.flatMap((ext) =>
      (ext.contentTypes ?? []).flatMap((ct) =>
        ct.visitorFacing === undefined ? [] : [[`${ext.id}.${ct.name}`, ct.visitorFacing] as const],
      ),
    ),
  );
  declareVisitorFacing(
    "extensions",
    "files",
    enabled.flatMap((ext) => (ext.visitorFacingFiles === undefined ? [] : [[ext.id, ext.visitorFacingFiles] as const])),
  );
}
