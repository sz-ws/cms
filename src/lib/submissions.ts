import { and, count, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "./db";
import { contents, contentSubmissions } from "./schema";
import {
  DEFAULT_SUBMISSION_STATE,
  SUBMISSION_STATES,
  type SubmissionState,
} from "@/ext/dx/submission";

// 收件匣的資料層(表:migrations/0014_content_submissions.sql)。
//
// ── 為什麼不是重新詮釋 contents.status ─────────────────────────────────────
// status 只有 'draft' | 'published' 兩個值,而且三個地方靠它吃飯:
//   - src/lib/jobs.ts 的 publish-due(status='draft' AND publish_at IS NOT NULL)
//   - 公開 Content API(強制 filter.status='published')
//   - 公開 list/detail views
// 往裡面塞 'unread'/'archived' 會逼所有這些述詞重新論證一次「新的值空間會不會漏」,
// 而且 ContentEntry.status 在整個 provider 契約上就是 'draft'|'published'
// (CoreContentProvider.rowToEntry 會把任何其他值硬轉成 'draft'),要改就是動 CORE_API
// 的型別表面。側表讓 status 一個字都不用改 —— 於是那三個述詞的行為**可證明**沒被本次
// 改動影響:submission 列仍是 status='draft'、publish_at=NULL,公開 API 依定義看不到它。
//
// ── 三個狀態,不多不少 ────────────────────────────────────────────────────
// unread / read / archived 對應操作者真正會問的三個問題:這是新的嗎?我看過了嗎?
// 我處理完了嗎?再細就是 CRM,不是 CMS。
//
// 「已回覆」不是第四個狀態,是獨立欄位 repliedAt:回覆與歸檔正交(回完信通常就會歸檔),
// 壓進同一條狀態機只會把「有沒有人回這個人」這個唯一有價值的紀錄弄丟。
//
// ── 沒有列 = 未讀 ─────────────────────────────────────────────────────────
// 本功能上線前既有的提交(舊站台的 contact draft 列)在側表沒有對應列。讀取端一律
// COALESCE 成 'unread',所以零 backfill、零 migration 風險。新進來的提交則在建立當下
// 就 stamp 一列 —— 那正是 publish-due 的 NOT EXISTS 防護能看見的東西
// (見 src/lib/jobs.ts publishDueJob 的 WHERE)。
//
// ── 失敗語意 ──────────────────────────────────────────────────────────────
// stampNewSubmission 是 best-effort(同 FTS 索引 / 版本歷史的哲學):收件標記寫失敗
// 絕不能讓訪客的表單送出失敗 —— 那筆訊息本身已經安全落庫,而缺一列側表只是讓它被讀成
// 「未讀」,剛好就是正確答案。相對地,操作者明確按下的狀態變更(setSubmissionState /
// setSubmissionReplied)失敗就要照常拋,呼叫端轉成錯誤回應。

/** 收件匣列表的一列(已解析,供 admin surface 直接渲染)。 */
export interface SubmissionRow {
  id: string;
  state: SubmissionState;
  repliedAt: number | null;
  createdAt: number;
  data: Record<string, unknown>;
}

/** 各狀態筆數(未讀含側表無列者)。 */
export interface SubmissionCounts {
  unread: number;
  read: number;
  archived: number;
  total: number;
}

const PER_PAGE_CAP = 100;

function parseData(raw: string): Record<string, unknown> {
  try {
    const j = JSON.parse(raw) as unknown;
    if (j && typeof j === "object" && !Array.isArray(j)) {
      return j as Record<string, unknown>;
    }
  } catch {
    // 損壞的 JSON:以空 document 續行(同 jobs.ts / rowToEntry 的既有哲學)。
  }
  return {};
}

/**
 * 新提交落庫後補上收件紀錄。best-effort:失敗只記錄,不拋(見檔頭失敗語意)。
 * 冪等 —— 重複呼叫由主鍵擋下(onConflictDoNothing)。
 */
export async function stampNewSubmission(
  contentId: string,
  type: string,
  now: number = Date.now(),
): Promise<void> {
  try {
    await db()
      .insert(contentSubmissions)
      .values({
        contentId,
        type,
        state: DEFAULT_SUBMISSION_STATE,
        repliedAt: null,
        updatedAt: now,
      })
      .onConflictDoNothing();
  } catch (e) {
    console.error("[submissions] stamp failed", contentId, e);
  }
}

/**
 * 取一頁收件匣。`state` 省略 = 全部;帶 "unread" 時**必須**把側表無列者一併算進來
 * (見檔頭「沒有列 = 未讀」)。排序恆為 createdAt desc —— 收件匣是時間序,不是可排序表格。
 */
export async function listSubmissions(
  type: string,
  opts: { state?: SubmissionState; page?: number; perPage?: number } = {},
): Promise<{ items: SubmissionRow[]; total: number }> {
  const perPage = Math.min(Math.max(1, Math.floor(opts.perPage ?? 25)), PER_PAGE_CAP);
  const page = Math.max(1, Math.floor(opts.page ?? 1));

  // 先把該 type 的收件紀錄全撈進記憶體再過濾/分頁?不行 —— 無界。改成:以 contents
  // 為主表 LEFT JOIN 側表,狀態述詞直接下在 SQL,分頁交給 DB。
  const joined = db()
    .select({
      id: contents.id,
      createdAt: contents.createdAt,
      data: contents.data,
      state: contentSubmissions.state,
      repliedAt: contentSubmissions.repliedAt,
    })
    .from(contents)
    .leftJoin(contentSubmissions, eq(contentSubmissions.contentId, contents.id));

  const where = stateWhere(type, opts.state);

  const rows = await joined
    .where(where)
    .orderBy(desc(contents.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);

  const countRows = await db()
    .select({ n: count() })
    .from(contents)
    .leftJoin(contentSubmissions, eq(contentSubmissions.contentId, contents.id))
    .where(where);

  return {
    items: rows.map((row) => ({
      id: row.id,
      state: row.state ?? DEFAULT_SUBMISSION_STATE,
      repliedAt: row.repliedAt ?? null,
      createdAt: row.createdAt,
      data: parseData(row.data),
    })),
    total: countRows[0]?.n ?? 0,
  };
}

/**
 * 狀態述詞。unread 特別處理:側表無列(JOIN 後 state IS NULL)亦屬未讀,
 * 故條件是 `state IS NULL OR state = 'unread'`。未帶 state → 只鎖定 type。
 */
function stateWhere(
  type: string,
  state: SubmissionState | undefined,
): SQL | undefined {
  const byType = eq(contents.type, type);
  if (!state) return byType;
  if (state === DEFAULT_SUBMISSION_STATE) {
    return and(
      byType,
      or(isNull(contentSubmissions.state), eq(contentSubmissions.state, state)),
    );
  }
  return and(byType, eq(contentSubmissions.state, state));
}

/** 各狀態筆數。一次 group by + 一次總數,未讀補上側表無列者。 */
export async function submissionCounts(
  type: string,
): Promise<SubmissionCounts> {
  const totalRows = await db()
    .select({ n: count() })
    .from(contents)
    .where(eq(contents.type, type));
  const total = totalRows[0]?.n ?? 0;

  const stated = await db()
    .select({ state: contentSubmissions.state, n: count() })
    .from(contentSubmissions)
    .where(eq(contentSubmissions.type, type))
    .groupBy(contentSubmissions.state);

  const byState: Record<SubmissionState, number> = {
    unread: 0,
    read: 0,
    archived: 0,
  };
  let recorded = 0;
  for (const row of stated) {
    const s = row.state as SubmissionState;
    if (s in byState) {
      byState[s] += row.n;
      recorded += row.n;
    }
  }
  // 側表沒有紀錄的舊列一律算未讀。
  byState.unread += Math.max(0, total - recorded);

  return { ...byState, total };
}

/**
 * 設定狀態(upsert:舊列尚無側表紀錄時補建)。回傳 false = 該 id 不屬於這個 type
 * (呼叫端轉 404;避免用任意 id 探測其他型別的資料)。
 */
export async function setSubmissionState(
  type: string,
  contentId: string,
  state: SubmissionState,
  now: number = Date.now(),
): Promise<boolean> {
  if (!(SUBMISSION_STATES as readonly string[]).includes(state)) return false;
  if (!(await belongsToType(type, contentId))) return false;
  await db()
    .insert(contentSubmissions)
    .values({ contentId, type, state, repliedAt: null, updatedAt: now })
    .onConflictDoUpdate({
      target: contentSubmissions.contentId,
      set: { state, updatedAt: now },
    });
  return true;
}

/**
 * 記錄 / 清除「已回覆」。設為已回覆時順手把 unread 推進 read —— 回了信卻還顯示未讀
 * 是明顯錯的,而這是唯一一個狀態可以安全自動推進的時機。
 */
export async function setSubmissionReplied(
  type: string,
  contentId: string,
  replied: boolean,
  now: number = Date.now(),
): Promise<boolean> {
  if (!(await belongsToType(type, contentId))) return false;
  const repliedAt = replied ? now : null;
  const existing = await db()
    .select({ state: contentSubmissions.state })
    .from(contentSubmissions)
    .where(eq(contentSubmissions.contentId, contentId))
    .limit(1);
  const current = existing[0]?.state ?? DEFAULT_SUBMISSION_STATE;
  const nextState: SubmissionState =
    replied && current === "unread" ? "read" : (current as SubmissionState);

  await db()
    .insert(contentSubmissions)
    .values({ contentId, type, state: nextState, repliedAt, updatedAt: now })
    .onConflictDoUpdate({
      target: contentSubmissions.contentId,
      set: { state: nextState, repliedAt, updatedAt: now },
    });
  return true;
}

/**
 * 刪除某列的收件紀錄。migration 已宣告 ON DELETE CASCADE,但 **D1 是否開啟 FK
 * enforcement 不在本層的掌控內**(src/lib/revisions.ts 的 deleteRevisionsFor 為了
 * 同一個理由也明確再刪一次),故內容刪除路徑會再明確刪一次。best-effort:失敗只記錄
 * —— 殘留的孤兒列讀不到也不會外洩(所有讀取都從 contents LEFT JOIN 過來),
 * 只是佔一點空間,絕不值得讓刪除本身失敗。
 */
export async function deleteSubmissionRecord(contentId: string): Promise<void> {
  try {
    await db()
      .delete(contentSubmissions)
      .where(eq(contentSubmissions.contentId, contentId));
  } catch (e) {
    console.error("[submissions] record cleanup failed", contentId, e);
  }
}

/** 該 content id 是否確實屬於這個 type(狀態變更前的歸屬檢查)。 */
async function belongsToType(type: string, contentId: string): Promise<boolean> {
  const rows = await db()
    .select({ id: contents.id })
    .from(contents)
    .where(and(eq(contents.type, type), eq(contents.id, contentId)))
    .limit(1);
  return rows.length > 0;
}

/** 批次讀取狀態(供列表以外的少數場景;目前僅測試與未來 dashboard 卡使用)。 */
export async function submissionStatesFor(
  contentIds: readonly string[],
): Promise<Map<string, SubmissionState>> {
  const out = new Map<string, SubmissionState>();
  if (contentIds.length === 0) return out;
  const rows = await db()
    .select({
      contentId: contentSubmissions.contentId,
      state: contentSubmissions.state,
    })
    .from(contentSubmissions)
    .where(inArray(contentSubmissions.contentId, [...contentIds]));
  for (const row of rows) out.set(row.contentId, row.state as SubmissionState);
  for (const id of contentIds) {
    if (!out.has(id)) out.set(id, DEFAULT_SUBMISSION_STATE);
  }
  return out;
}
