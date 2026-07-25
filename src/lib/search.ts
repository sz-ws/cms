import { sql } from "drizzle-orm";
import { db } from "./db";
import { isMediaKey } from "@/ext/dx/media-key";
import { isTiptapDoc, richtextToPlainText } from "@/ext/dx/fields/richtext-schema";

// roadmap:D1 FTS5 admin full-text search。所有 FTS SQL 都收斂在此單一模組
// (drizzle-orm 無 FTS5 schema 支援,故一律走 sql`` raw template)。indexing 於
// application layer 進行 —— 內容寫入路徑(CoreContentProvider)在 create/update 後
// upsert、delete 後移除;draft 與 published 皆索引(admin 搜尋涵蓋全部),status 過濾
// 於查詢時 JOIN 回 contents 完成。
//
// The virtual table lives in migrations/0005 (content_id/type_key UNINDEXED,
// title/body indexed). It is NOT in drizzle's schema — FTS5 can't be modelled
// there — so every statement here is hand-written raw SQL.

/** 短於此長度的 query 直接視為空結果(見 route)。 */
export const MIN_QUERY_LENGTH = 2;
/** limit 上限(route clamp 到此值)。 */
export const MAX_SEARCH_LIMIT = 50;
/** 預設 limit(route 未帶或非法時)。 */
export const DEFAULT_SEARCH_LIMIT = 20;

// body 儲存上限:避免超大文件把 FTS 行撐爆(整體 body 於 join 後 concat)。
const BODY_MAX_CHARS = 20_000;
// 逐 richtext 欄位抽取的字元上限(遠大於 richtextToPlainText 預設 160;body 另有總上限)。
const RICHTEXT_FIELD_MAX = 100_000;

// ---- 文字抽取(TypeScript,寫入時 / backfill 時共用)----

/** 極簡 HTML 標籤剝除(無新依賴):把 `<...>` 換成空白後由呼叫端 collapse 空白。 */
function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, " ");
}

/** 單一值 → 純文字:string 剝 HTML;Tiptap doc → plain text;其餘 → 空字串。 */
function valueToText(value: unknown): string {
  if (typeof value === "string") return stripHtml(value);
  if (isTiptapDoc(value)) return richtextToPlainText(value, RICHTEXT_FIELD_MAX);
  return "";
}

/**
 * 遞迴蒐集一份 entry data 內所有可搜尋文字。
 * - string:media key(storage key 形狀)略過;其餘剝 HTML 後納入。
 * - Tiptap richtext doc:抽 plain text(只取文字節點,不含結構型別名)。
 * - array / object(group/repeater/blocks 等結構欄位):遞迴走值。物件的 `block`
 *   discriminator key 略過(是 block 名稱,非內容)。
 * - number / boolean / null:非文字,略過。
 * 註:relation/relations 為 entry id 字串,形狀無法與一般文字可靠區分,會被納入 —— 屬
 * 低訊噪雜訊(nanoid 幾乎不會命中使用者查詢),暫可接受;media key 已明確排除。
 */
function collectText(value: unknown, out: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (!isMediaKey(value)) out.push(stripHtml(value));
    return;
  }
  if (typeof value !== "object") return; // number / boolean
  if (isTiptapDoc(value)) {
    out.push(richtextToPlainText(value, RICHTEXT_FIELD_MAX));
    return;
  }
  if (Array.isArray(value)) {
    for (const el of value) collectText(el, out);
    return;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === "block") continue; // blocks discriminator,非內容
    collectText(v, out);
  }
}

// title 候選欄位(依序取第一個非空文字);皆無 → 空 title(body 仍可搜)。
const TITLE_KEYS = ["title", "name", "heading", "headline", "label"] as const;

/** 從 entry data 推導一個「標題感」字串供 title 欄與 snippet fallback。 */
function deriveTitle(data: Record<string, unknown>): string {
  for (const key of TITLE_KEYS) {
    const t = valueToText(data[key]).replace(/\s+/g, " ").trim();
    if (t.length > 0) return t;
  }
  return "";
}

/** 抽出 { title, body }:title 為標題感欄位,body 為全部可搜尋文字(含 title)。 */
export function extractSearchText(data: Record<string, unknown>): {
  title: string;
  body: string;
} {
  const title = deriveTitle(data);
  const parts: string[] = [];
  collectText(data, parts);
  let body = parts.join(" ").replace(/\s+/g, " ").trim();
  if (body.length > BODY_MAX_CHARS) body = body.slice(0, BODY_MAX_CHARS);
  return { title, body };
}

// ---- CJK 分詞(寫入與查詢兩端共用)----
//
// 問題:content_fts 用 unicode61 tokenizer,它不對中日韓做斷詞 —— 一整串
// 「關於我們」會變成**一個** token。而 buildMatchQuery 只在最後一個 term 加 `*`,
// 所以「關於」(前綴)找得到,「我們」(中間)永遠找不到。對中文站等於搜尋半殘。
//
// 為什麼不換 tokenizer:FTS5 的 trigram 能做子字串比對,但它要求查詢**至少三個字元**,
// 而中文最常見的正是兩字詞(我們、時間、公司)。換過去會讓最常見的查詢全部失效,
// 比現況更糟。
//
// 解法:在應用層把 CJK 字元逐字以空白隔開,讓每個字成為獨立 token。查詢端做同樣的
// 轉換,再把整個 term 包成 phrase("我 們"),FTS5 的 phrase 語意要求 token 連續出現
// —— 於是「我們」精準命中「關於我們」,而不是鬆散地比對到任何同時含「我」和「們」的
// 文件。Latin 完全不受影響,remove_diacritics 2 的重音摺疊照舊。
//
// 代價:索引變大(每個漢字一個 token),以及儲存的文字帶有插入的空白 —— 故讀取端用
// unsegmentCjk 還原。還原是「移除兩個 CJK 字元之間的單一空白」,對原文本來就有空白的
// 情形(如「關於 我們」)會一併吃掉那個空白。中文詞間本來就不用空白,此損失可接受。
const CJK_CLASS = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
const CJK_TEST = new RegExp(`[${CJK_CLASS}]`, "u");
const CJK_EACH = new RegExp(`[${CJK_CLASS}]`, "gu");
const CJK_JOINED = new RegExp(`(?<=[${CJK_CLASS}]) (?=[${CJK_CLASS}])`, "gu");

/** CJK 字元逐字以空白隔開;無 CJK 則原樣返回(Latin 零成本)。 */
export function segmentCjk(input: string): string {
  if (!CJK_TEST.test(input)) return input;
  return input
    .replace(CJK_EACH, (ch) => ` ${ch} `)
    .replace(/\s+/g, " ")
    .trim();
}

/** segmentCjk 的反向:移除兩個 CJK 字元之間的單一空白(供顯示用)。 */
export function unsegmentCjk(input: string): string {
  if (!CJK_TEST.test(input)) return input;
  return input.replace(CJK_JOINED, "");
}

// ---- FTS 行維護(app-layer indexing)----

/**
 * upsert 一筆 entry 的 FTS 行(先刪後插,以 content_id 為鍵)。draft/published 皆索引。
 * 直接對 content_fts 操作(FTS5 手動維護行,無 trigger)。
 */
export async function indexContentEntry(
  id: string,
  typeKey: string,
  locale: string,
  data: Record<string, unknown>,
): Promise<void> {
  const { title, body } = extractSearchText(data);
  await removeContentIndex(id);
  await db().run(
    sql`INSERT INTO content_fts (content_id, type_key, locale, title, body) VALUES (${id}, ${typeKey}, ${locale}, ${segmentCjk(title)}, ${segmentCjk(body)})`,
  );
}

/** 移除一筆 entry 的 FTS 行(delete 時呼叫)。 */
export async function removeContentIndex(id: string): Promise<void> {
  await db().run(sql`DELETE FROM content_fts WHERE content_id = ${id}`);
}

interface CountRow {
  n: number;
}

/** contents 全表 → 重建 content_fts(先清空)。匯出供未來 admin 手動 reindex 呼叫。 */
export async function reindexAll(): Promise<number> {
  await db().run(sql`DELETE FROM content_fts`);
  const rows = await db().all<{
    id: string;
    type: string;
    locale: string;
    data: string;
  }>(sql`SELECT id, type, locale, data FROM contents`);
  let indexed = 0;
  for (const row of rows) {
    let parsed: Record<string, unknown> = {};
    try {
      const j = JSON.parse(row.data) as unknown;
      if (j && typeof j === "object") parsed = j as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    const { title, body } = extractSearchText(parsed);
    await db().run(
      sql`INSERT INTO content_fts (content_id, type_key, locale, title, body) VALUES (${row.id}, ${row.type}, ${row.locale}, ${segmentCjk(title)}, ${segmentCjk(body)})`,
    );
    indexed++;
  }
  return indexed;
}

/**
 * 惰性 backfill:FTS 表為空但 contents 非空時(例如剛套用 migration、尚未有任何寫入
 * 觸發過索引),重建一次。使得無需手動 reindex 步驟。
 */
async function maybeBackfill(): Promise<void> {
  const ftsRows = await db().all<CountRow>(
    sql`SELECT count(*) AS n FROM content_fts`,
  );
  if ((ftsRows[0]?.n ?? 0) > 0) return;
  const contentRows = await db().all<CountRow>(
    sql`SELECT count(*) AS n FROM contents`,
  );
  if ((contentRows[0]?.n ?? 0) === 0) return;
  await reindexAll();
}

// ---- 查詢 ----

/**
 * 把使用者 query 淨化為安全的 FTS5 MATCH 字串:每個 term 以雙引號包起(中和 - " * ( )
 * OR NOT 等 FTS5 運算子),term 內的雙引號以 "" 跳脫。無字母/數字的 term(純標點)剔除。
 * 最後一個 term 加 `*` 做 prefix match(as-you-type 手感)。無有效 term → null。
 */
export function buildMatchQuery(raw: string): string | null {
  const terms = raw.trim().split(/\s+/).filter(Boolean);
  const quoted: string[] = [];
  for (const term of terms) {
    if (!/[\p{L}\p{N}]/u.test(term)) continue; // 純標點/運算子:剔除
    // CJK term 先逐字切開再整包引號包起 → FTS5 phrase,要求 token 連續出現。
    // 「我們」→ "我 們",精準命中「關於我們」而非任何含「我」與「們」的文件。
    const seg = segmentCjk(term);
    quoted.push(`"${seg.replace(/"/g, '""')}"`);
  }
  if (quoted.length === 0) return null;
  quoted[quoted.length - 1] = `${quoted[quoted.length - 1]}*`; // prefix on last term
  return quoted.join(" ");
}

export interface SearchResult {
  id: string;
  typeKey: string;
  /** 該筆內容的 locale(migrations/0011)。雙語站據此區分兩筆同名譯本。 */
  locale: string;
  title: string;
  snippet: string;
  status: "draft" | "published";
  updatedAt: number;
}

interface SearchRow {
  id: string;
  typeKey: string;
  locale: string;
  status: string;
  updatedAt: number;
  title: string | null;
  snippet: string | null;
}

/**
 * 執行搜尋:淨化 query → 惰性 backfill → FTS MATCH JOIN 回 contents 取 status/updatedAt。
 * 依 bm25 rank 排序(相關度優先),limit 由呼叫端 clamp(此處再夾一次上限防呆)。
 * query 過短或無有效 term → 空陣列。
 */
export async function searchContent(
  rawQuery: string,
  limit: number,
): Promise<SearchResult[]> {
  const q = rawQuery.trim();
  if (q.length < MIN_QUERY_LENGTH) return [];
  const match = buildMatchQuery(q);
  if (!match) return [];

  const safeLimit = Math.min(
    Math.max(1, Math.floor(Number.isFinite(limit) ? limit : DEFAULT_SEARCH_LIMIT)),
    MAX_SEARCH_LIMIT,
  );

  await maybeBackfill();

  // ⚠️ snippet() 的第二個參數是**欄位序號**。migrations/0011 在 type_key 之後插入
  // locale,故欄位序變成 0=content_id 1=type_key 2=locale 3=title 4=body ——
  // body 從 3 移到 4。這種東西改錯不會報錯,只會安靜地對錯欄位取片段。
  const rows = await db().all<SearchRow>(sql`
    SELECT
      c.id AS id,
      c.type AS typeKey,
      c.locale AS locale,
      c.status AS status,
      c.updated_at AS updatedAt,
      content_fts.title AS title,
      snippet(content_fts, 4, '', '', '…', 12) AS snippet
    FROM content_fts
    JOIN contents AS c ON c.id = content_fts.content_id
    WHERE content_fts MATCH ${match}
    ORDER BY rank
    LIMIT ${safeLimit}
  `);

  return rows.map((row) => {
    // 存進 FTS 的 title/body 是 CJK 逐字切開過的,顯示前要還原(見 segmentCjk 說明)。
    const title = unsegmentCjk(row.title ?? "");
    const rawSnippet = unsegmentCjk(row.snippet ?? "");
    const snippet = rawSnippet.length > 0 ? rawSnippet : title;
    return {
      id: row.id,
      typeKey: row.typeKey,
      locale: row.locale,
      title,
      snippet,
      status: row.status === "published" ? "published" : "draft",
      updatedAt: row.updatedAt,
    };
  });
}
