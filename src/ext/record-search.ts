import type { LocalizedString } from "@/lib/i18n/localized";
import { wallClock, zonedTimeToMs } from "@/lib/datetime";

// 1.40.0:extension 後台頁的搜尋 —— 插件宣告,core 負責畫與組 SQL。
//
// 以前每個插件的列表頁要搜尋,就得自己放搜尋框、自己讀網址、自己拼 LIKE(多數乾脆
// 沒有)。現在 adminPages 的每一頁可以宣告 `search`:
//
//   adminPages: [{ slug: "", title: "訂單", component, search: {
//     placeholder: "姓名、電話、Email 或訂單編號",
//     fields: { text: ["order_no", "customer_name"], phone: ["customer_phone"], date: "created_at" },
//     global: { id: "orders", label: "訂單", table: "ext_shop_orders", key: "order_no", title: "customer_name" },
//   } }]
//
//   - core 在頂欄(麵包屑右邊)畫搜尋框;有 date 欄位就多一個「期間」。條件放在網址
//     (?q=&from=&to=),每個插件長得一樣、位置一樣。
//   - 頁面拿條件:server 元件 parseRecordSearch(searchParams),client 元件
//     useRecordSearch();查詢用 recordSearchClauses(同一份 fields)組 WHERE。
//   - 加 `global` 就同時進 ⌘K 全站搜尋,點結果回到這一頁,並用 `?open=<key>` 打開那一筆
//     (ext/search-sources.ts)。
//
// 期間由瀏覽器換成 epoch ms(from 含、to 不含)。伺服器不知道管理者在哪個時區,
// 「9/1 到 9/18」該從哪一刻算起只有瀏覽器知道,所以日期換算在前端做(dayInputToMs)。

export interface RecordSearchFields {
  /** 部分比對的文字欄位(名字、Email、編號…)。 */
  text: string[];
  /** 電話欄位:比對時忽略空白與連字號(「0912-345-678」打「0912345」也找得到)。 */
  phone?: string[];
  /** 期間篩選用的時間欄位(epoch ms)。 */
  date?: string;
}

export interface RecordSearch {
  /** 查詢字串。 */
  q?: string;
  /** 時間下限(含),epoch ms。 */
  from?: number;
  /** 時間上限(不含),epoch ms。 */
  to?: number;
}

/** AdminPage.search:這一頁的搜尋宣告。 */
export interface AdminPageSearch {
  /** 搜尋框提示,如「姓名、電話、Email 或訂單編號」。 */
  placeholder: LocalizedString;
  fields: RecordSearchFields;
  /** 選填:同時放進 ⌘K 全站搜尋(只給 admin)。 */
  global?: GlobalSearchSource;
}

export interface GlobalSearchSource {
  /** extension 內唯一;全站識別是 `<extId>:<id>`。 */
  id: string;
  /** 結果旁的類別名稱,如「訂單」。 */
  label: LocalizedString;
  /** 資料表;須以 `ext_` 開頭(extension 的表),core 的表不開放。 */
  table: string;
  /** 主鍵欄位,點結果時帶進 `?open=`。 */
  key: string;
  /** 結果標題欄位。 */
  title: string;
  /** 副標欄位,以「 · 」串接。 */
  subtitle?: string[];
  /**
   * 取代別的 extension 的來源(`<extId>:<id>`)。接管同一張表的插件用它,⌘K 才不會
   * 同一筆資料出現兩次、而且點過去是接管後的頁面。
   */
  replaces?: string;
}

/** 點 ⌘K 結果打開某一筆時用的網址參數(頁面讀它來打開明細)。 */
export const OPEN_PARAM = "open";

const MAX_QUERY = 100;
// 2000-01-01 ~ 2200-01-01:擋掉秒/毫秒搞混或亂填的數字,不必精確。
const MIN_MS = 946_684_800_000;
const MAX_MS = 7_258_118_400_000;
const IDENT_RE = /^[a-z][a-z0-9_]{0,62}$/;

function toMs(value: string | null): number | undefined {
  if (!value || !/^\d{1,15}$/.test(value)) return undefined;
  const ms = Number(value);
  return ms >= MIN_MS && ms <= MAX_MS ? ms : undefined;
}

/** URL 參數 → RecordSearch。不合法的部分直接忽略,不報錯(後台篩選不該整頁失敗)。 */
export function parseRecordSearch(params: URLSearchParams): RecordSearch {
  const q = (params.get("q") ?? "").trim().slice(0, MAX_QUERY);
  const from = toMs(params.get("from"));
  const to = toMs(params.get("to"));
  return {
    ...(q ? { q } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  };
}

export function hasRecordSearch(search: RecordSearch): boolean {
  return Boolean(search.q) || search.from !== undefined || search.to !== undefined;
}

/** RecordSearch → URL 參數(與 parseRecordSearch 對稱),連結保留搜尋條件用。 */
export function recordSearchParams(search: RecordSearch): URLSearchParams {
  const params = new URLSearchParams();
  if (search.q) params.set("q", search.q);
  if (search.from !== undefined) params.set("from", String(search.from));
  if (search.to !== undefined) params.set("to", String(search.to));
  return params;
}

/** 欄位名要直接拼進 SQL:只收小寫識別字(宣告是開發者常數,仍擋注入面)。 */
export function isSqlIdentifier(name: string): boolean {
  return IDENT_RE.test(name);
}

/** LIKE 的萬用字元跳脫(配 `ESCAPE '\'`)。 */
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * RecordSearch → WHERE 子句(以 AND 串接)與依序對應 `?` 的參數。`alias` 是表在
 * 查詢裡的別名(如 "o"),沒有就留空。沒宣告 date 欄位時忽略期間。
 */
export function recordSearchClauses(
  fields: RecordSearchFields,
  search: RecordSearch,
  alias = "",
): { clauses: string[]; args: (string | number)[] } {
  for (const name of [...fields.text, ...(fields.phone ?? []), ...(fields.date ? [fields.date] : [])]) {
    if (!isSqlIdentifier(name)) throw new Error(`[record-search] invalid column "${name}"`);
  }
  if (alias && !isSqlIdentifier(alias)) throw new Error(`[record-search] invalid alias "${alias}"`);
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  const clauses: string[] = [];
  const args: (string | number)[] = [];

  const q = search.q?.trim();
  const phones = fields.phone ?? [];
  if (q && fields.text.length + phones.length > 0) {
    const text = likeContains(q);
    const digits = q.replace(/[\s-]/g, "");
    const phone = /^\+?\d{3,}$/.test(digits) ? likeContains(digits) : text;
    const terms = [
      ...fields.text.map((name) => {
        args.push(text);
        return `${col(name)} LIKE ? ESCAPE '\\'`;
      }),
      ...phones.map((name) => {
        args.push(phone);
        return `REPLACE(REPLACE(COALESCE(${col(name)}, ''), '-', ''), ' ', '') LIKE ? ESCAPE '\\'`;
      }),
    ];
    clauses.push(`(${terms.join(" OR ")})`);
  }
  if (fields.date && search.from !== undefined) {
    clauses.push(`${col(fields.date)} >= ?`);
    args.push(search.from);
  }
  if (fields.date && search.to !== undefined) {
    clauses.push(`${col(fields.date)} < ?`);
    args.push(search.to);
  }
  return { clauses, args };
}

// ---- 日期欄位 ↔ 期間(以「一整天」為單位)----
//
// 1.41.0:傳 timeZone(站台時區,useTimeZone())時,一天是站台時區的 00:00 到隔天
// 00:00 —— 在國外看後台的人篩出來的「9/18」跟店家說的是同一天。沒傳時照舊用執行
// 環境的時區(瀏覽器)。

/** `YYYY-MM-DD` → 當天 00:00 的 epoch ms;`end` 時回隔天 00:00(to 不含)。 */
export function dayInputToMs(value: string, end = false, timeZone?: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return undefined;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3]) + (end ? 1 : 0)];
  const ms = timeZone ? zonedTimeToMs({ year, month, day }, timeZone) : new Date(year, month - 1, day).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/** epoch ms → `YYYY-MM-DD`;`end` 表示這是不含的上限,顯示前一天。 */
export function msToDayInput(ms: number | undefined, end = false, timeZone?: string): string {
  if (ms === undefined) return "";
  const at = end ? ms - 1 : ms;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (timeZone) {
    const w = wallClock(at, timeZone);
    return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
  }
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
