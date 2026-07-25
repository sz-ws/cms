import { CORE_SETTINGS, secretKeySetAsync } from "./settings";
import { db } from "./db";
import { settings as settingsTable } from "./schema";

// 內容匯出引擎(「把我的資料拿回去」)。
//
// ---- 格式:NDJSON(每行一筆 JSON),不是單一 JSON envelope ----
// 理由:
//   1. **可串流**。單一 envelope 要嘛整包 buffer 進記憶體(Worker 128MB 直接爆),
//      要嘛手工拼括號/逗號 —— 後者一旦中斷就是無法 parse 的殘檔。NDJSON 天生逐行,
//      寫多少就是多少。
//   2. **中斷可辨識**。檔案最後一行必為 {"kind":"end"};沒有它就代表下載沒完成。
//      這是使用者唯一需要記住的完整性檢查。
//   3. **通用**。jq / DuckDB / pandas / Node 逐行讀都是一行程式,不需要我們的 SDK。
//   4. **異質紀錄**。meta / setting / media / entry 用 `kind` 區分,一個檔講完整件事,
//      不必為了「一個 type 一個檔」而去打包 zip(Worker 內沒有可靠的 streaming zip)。
//
// **不提供 CSV**(明確決定,不是遺漏):entry 的 data 是巢狀 JSON document
// (richtext doc、repeater/blocks 陣列、group 物件)。攤平成 CSV 必然失真,而且每個
// content type 的欄位都不同 —— 給出一個「看起來能用、其實掉資料」的格式,比不給更糟。
// 需要試算表的人可以用 `jq -r` 對單一 type 自行挑欄位,那是他們自己決定要丟什麼。
//
// ---- 紀錄順序 ----
// meta → setting* → media* → entry* → end
// media 排在 entry 前面,是因為 entry 才是會撞到上限的那一段;先把有界的東西寫完,
// 即使 entry 段被截斷,媒體清單仍是完整的。
//
// ---- 記憶體與 request context ----
// 產生器**只吃 binding(D1Database / R2Bucket)**,不碰任何 request-scoped API。
// 原因:stream 的 pull() 會在 route handler 回傳之後才被呼叫,那時
// getCloudflareContext() 的 AsyncLocalStorage 可能已經不在了。呼叫端必須在回傳
// Response **之前**把 binding 與所有 request-scoped 前置資料(meta / settings)算好
// 傳進來。

/** 格式識別字串。未來若破壞相容需 bump,importer 一律先讀這欄。 */
export const EXPORT_FORMAT = "szws-cms-export/1";

/** 每次 D1 查詢取幾列。250 × 一筆 JSON document ≈ 數百 KB,在 D1 回應大小內。 */
export const CONTENT_BATCH = 250;

/**
 * 匯出串流可花掉的 read page 總預算(媒體列舉與 entry 查詢共用)。Workers Free
 * 每 request 只有 50 個 subrequest；預設 35 頁，為 route return 前的 settings /
 * extension 前置查詢保留至少 15 個位置。帳號方案無法在 runtime 判定，付費方案可用
 * EXPORT_PAGE_BUDGET 覆寫(上限仍保留 100 個位置給其餘 request 工作)。
 */
export const DEFAULT_EXPORT_PAGE_BUDGET = 35;
export const MAX_EXPORT_PAGE_BUDGET = 900;

/** 預設情況(完全沒有媒體頁)可讀出的 entry 上限。實際上限受共用 page budget 約束。 */
export const MAX_ENTRIES = CONTENT_BATCH * DEFAULT_EXPORT_PAGE_BUDGET;

/** 部署設定是字串 binding；無效值一律退回保守的 Free-plan 預設。 */
export function exportPageBudget(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_EXPORT_PAGE_BUDGET;
  const value = Number(raw);
  return value >= 1 && value <= MAX_EXPORT_PAGE_BUDGET
    ? value
    : DEFAULT_EXPORT_PAGE_BUDGET;
}

/** R2 list 單頁上限(平台硬性),與 lib/storage.ts 的 listFiles 一致。 */
const MEDIA_PAGE_SIZE = 100;

/**
 * 媒體列舉的頁數上限 → 3,000 個物件。dashboard 的 STORAGE_PAGE_CAP 是 5 頁(500),
 * 那是「概覽數字不必精確」;匯出要的是清單本身,所以放寬,但仍必須有界 ——
 * 無界迴圈 = 打得爆 Worker 的 subrequest 預算。到頂一樣回 cursor 讓人續抓。
 */
const MAX_MEDIA_PAGES = 30;

// ---- 紀錄型別 ----

export interface ExportTypeInfo {
  type: string;
  label?: string;
  fields: { key: string; type: string }[];
}

export interface MetaRecord {
  kind: "meta";
  format: typeof EXPORT_FORMAT;
  exportedAt: number;
  /** 這次匯出實際含哪些紀錄種類。 */
  includes: ("setting" | "media" | "entry")[];
  /** 明確列出「沒有匯出什麼、為什麼」—— 讓收到檔案的人不必猜。 */
  excludes: { what: string; reason: string }[];
  /** 已啟用 extension 宣告的 content type schema(給未來的 importer 對欄位用)。 */
  types: ExportTypeInfo[];
  filter: { type: string | null; after: string | null };
  limits: { maxEntries: number; maxMediaObjects: number };
}

export interface SettingRecord {
  kind: "setting";
  key: string;
  value: unknown;
}

export interface MediaRecord {
  kind: "media";
  key: string;
  size: number;
  contentType: string;
  alt?: string;
  /** 公開的檔案位址(見 src/app/api/files/[[...key]]/route.ts,免登入)。 */
  url: string;
}

export interface EntryRecord {
  kind: "entry";
  type: string;
  id: string;
  slug: string | null;
  status: string;
  publishAt: number | null;
  data: unknown;
  /** data 欄位不是合法 JSON 時的逃生口(理論上不會發生,但不能因此讓整份匯出掛掉)。 */
  dataRaw?: string;
  createdAt: number;
  updatedAt: number;
  /**
   * contents 表上、本格式尚未認得的欄位(原始 snake_case 欄名)。
   * 用意:migration 加了新的 ROW 欄位時,匯出不會靜靜地把使用者的資料吃掉 ——
   * 沒人記得更新這支檔案,資料還是出得去。空的時候整個欄位省略。
   */
  extra?: Record<string, unknown>;
}

export interface WarningRecord {
  kind: "warning";
  phase: "media" | "entry";
  message: string;
}

export interface EndRecord {
  kind: "end";
  counts: { settings: number; media: number; entries: number };
  truncated: { media: boolean; entries: boolean };
  /** 截斷時的續抓參數;沒有截斷則為 null。 */
  resume: { after?: string; mediaCursor?: string } | null;
}

export type ExportRecord =
  | MetaRecord
  | SettingRecord
  | MediaRecord
  | EntryRecord
  | WarningRecord
  | EndRecord;

// ---- Secret 紅線:可匯出的 settings 白名單 ----

/**
 * 唯一會出現在匯出檔裡的 settings key。**白名單**,不是黑名單 —— 新增一個 secret
 * setting 不會因為有人忘了更新排除清單就外洩。
 *
 * 全部是「網站身分」等級、重建站台時得手動重打的東西;沒有任何一個是憑證。
 */
export const EXPORTABLE_SETTING_KEYS: readonly string[] = [
  "core.siteTitle",
  "core.siteDescription",
  "core.siteUrl",
  "core.locale",
  "core.seo.robots",
  "core.seo.sitemap",
  "core.seo.rss",
];

/**
 * 讀出可匯出的 settings(request-scoped:要 D1 + ext runtime)。
 *
 * **絕對規則:匯出檔裡永遠不會出現解密後的 secret。** 這裡不是「遮罩」而是「不放」——
 * 連 "•••" 佔位符都不寫,因為那只會讓人以為那格有東西。三道關卡:
 *   1. 白名單:只有 EXPORTABLE_SETTING_KEYS 的 key 有機會進來。
 *   2. runtime 判定:命中 secretKeySetAsync()(core + 已啟用 extension 的 secret 宣告)
 *      一律丟棄 —— 白名單裡的某個 key 哪天被標成 secret,這裡自動跟上。
 *   3. 靜態判定:CORE_SETTINGS 裡標了 secret 的也丟棄(即使 runtime 那步因故失敗)。
 * 三者任一命中就跳過,而且**沒有任何路徑會呼叫 decryptSecret**。
 *
 * `ext.*` 完全不匯出:停用中的 extension 不在 secretKeySetAsync() 的視野裡,
 * 無法判定它的某個 key 是不是 secret —— 判定不了就不出口。
 */
export async function collectExportableSettings(): Promise<SettingRecord[]> {
  const rows = await db().select().from(settingsTable);
  const stored = new Map(rows.map((r) => [r.key, r.value] as const));

  const coreSecret = new Set(
    CORE_SETTINGS.filter((f) => f.secret).map((f) => f.key),
  );
  let runtimeSecret: Set<string>;
  try {
    runtimeSecret = await secretKeySetAsync();
  } catch {
    // 判定不了就當作「全部都是 secret」——寧可少匯出,不可能誤放。
    return [];
  }

  const out: SettingRecord[] = [];
  for (const key of EXPORTABLE_SETTING_KEYS) {
    if (!key.startsWith("core.")) continue;
    if (coreSecret.has(key) || runtimeSecret.has(key)) continue;
    const raw = stored.get(key);
    if (raw === undefined) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue; // 壞掉的值不猜,直接略過。
    }
    out.push({ kind: "setting", key, value });
  }
  return out;
}

// ---- 匯出主體 ----

export interface ExportOptions {
  d1: D1Database;
  r2: R2Bucket | undefined;
  meta: MetaRecord;
  settings: SettingRecord[];
  /** 只匯出這個 content type;null = 全部。 */
  type: string | null;
  /** keyset 續抓起點(上一份匯出的 end.resume.after)。 */
  after: string | null;
  /** R2 續抓 cursor(上一份匯出的 end.resume.mediaCursor)。 */
  mediaCursor: string | null;
  /** media 與 entry 共用的 read page 預算；route 以部署設定提供，測試可直接指定。 */
  pageBudget?: number;
}

interface ContentRow extends Record<string, unknown> {
  id: string;
  type: string;
  slug: string | null;
  status: string;
  publish_at: number | null;
  data: string;
  created_at: number;
  updated_at: number;
}

/** 已對應到具名欄位的 contents 欄名;其餘進 EntryRecord.extra。 */
const KNOWN_CONTENT_COLUMNS = new Set([
  "id",
  "type",
  "slug",
  "status",
  "publish_at",
  "data",
  "created_at",
  "updated_at",
]);

/**
 * 逐筆產生匯出紀錄。**不 buffer 全量** —— 任何時刻記憶體裡只有一批(250 列)。
 *
 * 分頁走 keyset(`WHERE id > ? ORDER BY id`)而非 OFFSET:id 是 PRIMARY KEY,
 * 每批都是索引定位,第 100 批和第 1 批一樣快;OFFSET 則會愈翻愈慢,大站必超時。
 *
 * 任何一段出錯都轉成 warning 後仍走到 end，確保 consumer 永遠能讀到最後一行；但
 * end 會明確標記 truncated 並附上可用 cursor，**只有 truncated 全為 false 才完整**。
 */
export async function* exportRecords(
  opts: ExportOptions,
): AsyncGenerator<ExportRecord> {
  yield opts.meta;
  for (const s of opts.settings) yield s;

  // options 是內部 API，但仍防禦呼叫端直接傳錯數字，不能因此繞過 deployment 上限。
  const pageBudget =
    typeof opts.pageBudget === "number" &&
    Number.isInteger(opts.pageBudget) &&
    opts.pageBudget >= 1 &&
    opts.pageBudget <= MAX_EXPORT_PAGE_BUDGET
      ? opts.pageBudget
      : DEFAULT_EXPORT_PAGE_BUDGET;
  let pagesRemaining = pageBudget;

  // ---- media:R2 物件清單(只有 key,沒有 bytes)----
  let mediaCount = 0;
  let mediaTruncated = false;
  let nextMediaCursor: string | undefined;
  if (opts.r2) {
    let cursor = opts.mediaCursor ?? undefined;
    try {
      for (let page = 0; page < MAX_MEDIA_PAGES; page++) {
        if (pagesRemaining === 0) {
          // 沒有多打一個 R2 list 來「猜」還有沒有下一頁；保守地交回目前 cursor。
          mediaTruncated = true;
          nextMediaCursor = cursor;
          break;
        }
        const listed = await opts.r2.list({
          cursor,
          limit: MEDIA_PAGE_SIZE,
          include: ["httpMetadata", "customMetadata"],
        });
        pagesRemaining--;
        for (const o of listed.objects) {
          const alt = o.customMetadata?.["alt"];
          mediaCount++;
          yield {
            kind: "media",
            key: o.key,
            size: o.size,
            contentType:
              o.httpMetadata?.contentType ?? "application/octet-stream",
            ...(alt ? { alt } : {}),
            url: `/api/files/${o.key}`,
          };
        }
        if (!listed.truncated) {
          cursor = undefined;
          break;
        }
        cursor = listed.cursor;
        if (page === MAX_MEDIA_PAGES - 1 || pagesRemaining === 0) {
          mediaTruncated = true;
          nextMediaCursor = cursor;
          break;
        }
      }
    } catch (e) {
      // R2 cursor 是「這次失敗的 page」起點；不丟它，下一份就無法補回這段。
      mediaTruncated = true;
      nextMediaCursor = cursor;
      yield {
        kind: "warning",
        phase: "media",
        message: e instanceof Error ? e.message : "media listing failed",
      };
    }
  }

  // ---- entries ----
  let entryCount = 0;
  let entriesTruncated = false;
  let lastId = opts.after ?? "";
  const where = opts.type
    ? "WHERE type = ?2 AND id > ?1"
    : "WHERE id > ?1";
  // SELECT *(而非列舉欄位):日後 migration 新增的 ROW 欄位會自動落進 extra,
  // 不會因為沒人回來改這行就把使用者的資料留在資料庫裡。
  const sql = `SELECT * FROM contents ${where} ORDER BY id ASC LIMIT ${CONTENT_BATCH}`;

  try {
    for (;;) {
      if (pagesRemaining === 0) {
        // 預算用盡時不探測下一頁；寧可要求一次空的續抓，也不能宣告完整。
        entriesTruncated = true;
        break;
      }
      const stmt = opts.d1.prepare(sql);
      const bound = opts.type ? stmt.bind(lastId, opts.type) : stmt.bind(lastId);
      const { results } = await bound.all<ContentRow>();
      pagesRemaining--;
      if (results.length === 0) break;

      for (const row of results) {
        lastId = row.id;
        let data: unknown;
        let dataRaw: string | undefined;
        try {
          data = JSON.parse(row.data);
        } catch {
          data = null;
          dataRaw = row.data;
        }
        const extra: Record<string, unknown> = {};
        for (const [col, val] of Object.entries(row)) {
          if (!KNOWN_CONTENT_COLUMNS.has(col)) extra[col] = val;
        }
        entryCount++;
        yield {
          kind: "entry",
          type: row.type,
          id: row.id,
          slug: row.slug,
          status: row.status,
          publishAt: row.publish_at,
          data,
          ...(dataRaw === undefined ? {} : { dataRaw }),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          ...(Object.keys(extra).length > 0 ? { extra } : {}),
        };
      }
      if (results.length < CONTENT_BATCH) break;
      if (pagesRemaining === 0) {
        // 最後一頁剛好滿批時，不能再用額外 D1 查詢確認尾端；保守地標記 incomplete。
        entriesTruncated = true;
        break;
      }
    }
  } catch (e) {
    // 前面已成功 yield 的 lastId 就是可重啟的 keyset cursor；這不能只是一行 warning。
    entriesTruncated = true;
    yield {
      kind: "warning",
      phase: "entry",
      message: e instanceof Error ? e.message : "content read failed",
    };
  }

  const resume =
    entriesTruncated || mediaTruncated
      ? {
          ...(entriesTruncated && lastId ? { after: lastId } : {}),
          ...(nextMediaCursor ? { mediaCursor: nextMediaCursor } : {}),
        }
      : null;

  yield {
    kind: "end",
    counts: {
      settings: opts.settings.length,
      media: mediaCount,
      entries: entryCount,
    },
    truncated: { media: mediaTruncated, entries: entriesTruncated },
    resume,
  };
}

/**
 * AsyncIterable<ExportRecord> → NDJSON 的 ReadableStream。
 *
 * pull() 才拉下一批 = 真的有 backpressure:client 慢下來,我們就不再查 D1。
 * 每次 pull 湊到 ~64KB 才 enqueue,避免一筆一個 chunk 的呼叫開銷。
 */
export function ndjsonStream(
  records: AsyncIterable<ExportRecord>,
): ReadableStream<Uint8Array> {
  const iterator = records[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const CHUNK_TARGET = 64 * 1024;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let buffer = "";
      while (buffer.length < CHUNK_TARGET) {
        const { value, done } = await iterator.next();
        if (done) {
          if (buffer.length > 0) controller.enqueue(encoder.encode(buffer));
          controller.close();
          return;
        }
        buffer += JSON.stringify(value) + "\n";
      }
      controller.enqueue(encoder.encode(buffer));
    },
    async cancel() {
      // client 中止下載 → 讓 generator 收尾,別留著查 D1。
      await iterator.return?.(undefined);
    },
  });
}
