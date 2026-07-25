import { nanoid } from "nanoid";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { db } from "./db";
import { contentRevisions, users } from "./schema";
import { getSetting } from "./settings";
import { getSessionUser } from "./auth";

// 內容版本歷史(migrations/0010_content_revisions.sql)的資料層:擷取、修剪、讀取
// 收斂在這裡,寫入路徑(CoreContentProvider)只呼叫 captureRevision()。還原(寫入
// 動作,需自備 hook / FTS / cache 副作用)住隔壁的 ./revision-restore。
//
// ── 三個設計決策(理由寫在這,不要靠猜)────────────────────────────────────
//
// 1) 儲存形狀 = **完整快照**,不是 diff。
//    content row 是小份 JSON document,而 D1 的成本模型是「往返次數」而非位元組。
//    diff 鏈要還原任一版本得沿鏈讀 O(n) 次(每次都是一趟網路),還得自備一套永遠不能
//    有 bug 的 diff/patch,且鏈中任何一列壞掉,它之後的所有版本一起失效。快照是一次
//    讀取、還原邏輯 = 覆寫,壞掉的列只影響它自己。體積上限由保留策略(下方)管,
//    不由 diff 管。
//
// 2) 保留策略 = **每個 content row 保留最新 N 筆**(`core.revisions.keep`,預設 20;
//    0 = 完全停用擷取)。不用純年齡制:一年只改一次的頁面在年齡制下會把歷史清空,
//    而那正是客戶最可能弄壞、最需要 undo 的頁面。每列上限也讓最壞情況可算
//    (content 列數 × N),不會被單一被瘋狂編輯的頁面拖垮整張表。
//
// 3) 何時產生一筆 = **create 一定產生;update 在合併視窗內就地覆寫最新那筆**
//    (`core.revisions.coalesceMs`,預設 5 分鐘)。合併只在「同一個人、狀態沒變、
//    上一筆本身就是 update」三個條件同時成立時才發生,所以:
//      - 編輯者連按十次儲存 = 1 筆,不是 10 筆(這就是「打字不該產生 200 列」的解)。
//      - 換人編輯 → 一定新開一筆(誰改的必須答得出來)。
//      - draft⇄published 的狀態轉換 → 一定新開一筆(那是有意義的檢查點)。
//      - create 那筆(初始狀態)永不被覆寫,所以「回到最初」永遠做得到。
//    restore 也一定新開一筆:還原不銷毀歷史,被還原掉的那個壞版本仍留在列表裡,
//    直到被保留數修掉為止(也就是 undo 可以 redo)。
//
// ── publish-due(排程發佈)刻意不留版本 ────────────────────────────────────
// src/lib/jobs.ts 的 publish-due 是機器驅動的狀態翻轉:它只把到期的 draft 改成
// published 並清掉 publish_at,**不動 data 一個位元組**。人類上一次編輯時的快照已經
// 完整記在歷史裡,再多記一筆只是同一份內容換個 status,對「客戶把頁面改壞了要回頭」
// 這件事沒有任何幫助,卻會在每個排程站台上白白吃掉保留額度(預設 20 筆之一)。
// 版本歷史記的是**人做的內容變更**,排程只是把那個變更在約定時間放出去。
// (一致性檢查:透過 provider.update() 送出的 status 改變確實會留版本 —— 那是人按的,
//  而且同一次寫入可能一起改了 data。兩者的分野是「誰改的、有沒有改內容」,不是
//  「status 有沒有變」。)
//
// ── 失敗語意 ───────────────────────────────────────────────────────────────
// 擷取是 **best-effort**,與 CoreContentProvider 的 FTS 索引同哲學:歷史寫失敗
// (migration 尚未套用、表不存在、actor FK 對不上)絕不連累內容本身的寫入 —— 對一個
// 交付給客戶自己編輯的 CMS 來說,「存不進去」比「這次沒留下歷史」嚴重得多。失敗一律
// console.error,不 throw。還原(restoreRevision)反過來:那是使用者明確要求的動作,
// 失敗必須讓呼叫端知道,故照常拋。

/** `core.revisions.keep` 預設值:每個 content row 保留幾筆。 */
export const DEFAULT_REVISION_KEEP = 20;
/** keep 的硬上限:設定值再離譜也不會超過(單列歷史的成本上界)。 */
export const REVISION_KEEP_CEILING = 200;
/** `core.revisions.coalesceMs` 預設值:5 分鐘內同一人的連續 update 合併成一筆。 */
export const DEFAULT_REVISION_COALESCE_MS = 5 * 60_000;
/** coalesce 視窗的硬上限:24 小時(再長就等於整天只留一筆,失去 undo 意義)。 */
export const REVISION_COALESCE_CEILING_MS = 24 * 60 * 60_000;

export type RevisionReason = "create" | "update" | "restore";

/** 版本列表用的輕量投影(不含 data 快照本身,列表不需要整份文件)。 */
export interface RevisionSummary {
  id: string;
  contentId: string;
  type: string;
  slug: string | null;
  status: string;
  publishAt: number | null;
  reason: RevisionReason;
  createdAt: number;
  /** users 表 join 出的名字;查無使用者 → null(絕不外露內部 user id)。 */
  actorName: string | null;
}

/** 單筆版本的完整內容(summary + JSON 快照)。 */
export interface RevisionDetail extends RevisionSummary {
  data: Record<string, unknown>;
}

interface CaptureInput {
  contentId: string;
  type: string;
  slug: string | null;
  status: string;
  publishAt: number | null;
  data: Record<string, unknown>;
  reason: RevisionReason;
  /** 明確指定寫入者;省略 → 由當次 request session 解析(無 session → null)。 */
  actorId?: string | null;
  /** 測試/確定性用;省略 → Date.now()。 */
  now?: number;
}

/** 設定值 → 合法整數(非數字 / 負數 / NaN 一律回退預設),並夾在上限內。 */
function clampInt(raw: unknown, fallback: number, ceiling: number): number {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseInt(raw, 10)
        : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), ceiling);
}

/**
 * 每列保留筆數。0 = 停用版本歷史(不寫、不修剪;既有列留著不動,重新開啟即回來)。
 *
 * 走 settings.ts 的公開 API(getSetting,整包 settings 已有 per-request + module 級
 * 快取,這裡不另外做快取)。此 key **尚未**登記進 CORE_SETTINGS,所以還不會出現在
 * /admin/settings 表單上 —— 見 README of this change:登記那一行屬於 settings.ts,
 * 該檔案目前由別的工作佔用,不在此改動。
 */
export async function revisionKeep(): Promise<number> {
  return readSetting(
    "core.revisions.keep",
    DEFAULT_REVISION_KEEP,
    REVISION_KEEP_CEILING,
  );
}

/** 連續 update 的合併視窗(毫秒)。0 = 不合併,每次 update 都新開一筆。 */
export async function revisionCoalesceMs(): Promise<number> {
  return readSetting(
    "core.revisions.coalesceMs",
    DEFAULT_REVISION_COALESCE_MS,
    REVISION_COALESCE_CEILING_MS,
  );
}

/**
 * 讀一個數值 setting;讀取本身失敗一律回退預設值。
 * 這兩支會被 CoreContentProvider.update() 在寫入路徑上直接呼叫(用來決定要不要多讀
 * 一次 publishAt),所以它們**不能**是內容儲存的新失敗點 —— 與檔頭的 best-effort
 * 原則一致:歷史的設定讀不到,頂多回到預設行為,不會讓使用者存不了東西。
 */
async function readSetting(
  key: string,
  fallback: number,
  ceiling: number,
): Promise<number> {
  let raw: unknown;
  try {
    raw = await getSetting<unknown>(key, undefined);
  } catch (e) {
    console.error(`[revisions] setting read failed key=${key}`, e);
    return fallback;
  }
  if (raw === undefined) return fallback;
  return clampInt(raw, fallback, ceiling);
}

/**
 * 當次 request 的 session user id。沒有 request context(cron / scheduled / 背景任務)
 * 或未登入(public:true 的匿名建立)→ null。cookies() 在 request scope 外會 throw,
 * 故整段包 try/catch —— 取不到寫入者不該讓寫入失敗。
 */
async function currentActorId(): Promise<string | null> {
  try {
    const user = await getSessionUser();
    return user?.id ?? null;
  } catch {
    return null;
  }
}

function parseSnapshot(raw: string): Record<string, unknown> {
  try {
    const j = JSON.parse(raw) as unknown;
    if (j && typeof j === "object" && !Array.isArray(j)) {
      return j as Record<string, unknown>;
    }
  } catch {
    // 損壞的快照:以空 document 續行(同 jobs.ts parseData 哲學,不讓一列壞資料炸掉列表)。
  }
  return {};
}

/**
 * 修剪:只留該 content row 最新的 `keep` 筆。兩段式(先撈要留的 id,再刪其餘)——
 * 這樣同時處理「剛多出來一筆」與「keep 被調小後留下的一堆舊列」,而不是只刪最舊一筆。
 * keep 已被夾在 REVISION_KEEP_CEILING 內,所以 notInArray 的參數量有界。
 */
export async function pruneRevisions(
  contentId: string,
  keep: number,
): Promise<number> {
  if (keep <= 0) return 0;
  const survivors = await db()
    .select({ id: contentRevisions.id })
    .from(contentRevisions)
    .where(eq(contentRevisions.contentId, contentId))
    .orderBy(desc(contentRevisions.createdAt), desc(contentRevisions.id))
    .limit(keep);
  if (survivors.length < keep) return 0; // 還沒滿,必無可刪。
  const keepIds = survivors.map((r) => r.id);
  const removed = await db()
    .delete(contentRevisions)
    .where(
      and(
        eq(contentRevisions.contentId, contentId),
        notInArray(contentRevisions.id, keepIds),
      ),
    )
    .returning({ id: contentRevisions.id });
  return removed.length;
}

/**
 * 擷取一筆版本(post-image:存的是這次寫入**之後**的狀態,所以最新一筆恆等於目前
 * 線上的內容,還原 = 挑舊的那筆覆寫回去)。best-effort,見檔頭失敗語意。
 */
export async function captureRevision(input: CaptureInput): Promise<void> {
  try {
    const keep = await revisionKeep();
    if (keep <= 0) return; // 停用。

    const now = input.now ?? Date.now();
    const actorId =
      input.actorId !== undefined ? input.actorId : await currentActorId();
    const payload = JSON.stringify(input.data);

    // 合併判定:只有 update 會併,而且只併進「上一筆也是 update、同一個人、狀態沒變、
    // 還在視窗內」的那筆。create 那筆(初始狀態)與 restore 那筆永不被覆寫。
    if (input.reason === "update") {
      const coalesceMs = await revisionCoalesceMs();
      if (coalesceMs > 0) {
        const latest = await db()
          .select({
            id: contentRevisions.id,
            actorId: contentRevisions.actorId,
            status: contentRevisions.status,
            reason: contentRevisions.reason,
            createdAt: contentRevisions.createdAt,
          })
          .from(contentRevisions)
          .where(eq(contentRevisions.contentId, input.contentId))
          .orderBy(desc(contentRevisions.createdAt), desc(contentRevisions.id))
          .limit(1);
        const prev = latest[0];
        if (
          prev &&
          prev.reason === "update" &&
          prev.actorId === actorId &&
          prev.status === input.status &&
          now - prev.createdAt < coalesceMs
        ) {
          await db()
            .update(contentRevisions)
            .set({
              slug: input.slug,
              publishAt: input.publishAt,
              data: payload,
              createdAt: now,
            })
            .where(eq(contentRevisions.id, prev.id));
          return; // 就地覆寫,列數不變,不必修剪。
        }
      }
    }

    await db().insert(contentRevisions).values({
      id: nanoid(),
      contentId: input.contentId,
      type: input.type,
      slug: input.slug,
      status: input.status,
      publishAt: input.publishAt,
      data: payload,
      actorId,
      reason: input.reason,
      createdAt: now,
    });
    await pruneRevisions(input.contentId, keep);
  } catch (e) {
    // 見檔頭:歷史寫失敗絕不連累內容寫入。
    console.error("[revisions] capture failed", input.contentId, e);
  }
}

/** content row 被刪除時一併清歷史(不倚賴 D1 是否開啟 FK enforcement)。best-effort。 */
export async function deleteRevisionsFor(contentId: string): Promise<void> {
  try {
    await db()
      .delete(contentRevisions)
      .where(eq(contentRevisions.contentId, contentId));
  } catch (e) {
    console.error("[revisions] delete failed", contentId, e);
  }
}

/** 列表(新→舊)。actor 以 leftJoin users 換成名字;查無使用者 → null。 */
export async function listRevisions(
  contentId: string,
  limit = REVISION_KEEP_CEILING,
): Promise<RevisionSummary[]> {
  const rows = await db()
    .select({
      id: contentRevisions.id,
      contentId: contentRevisions.contentId,
      type: contentRevisions.type,
      slug: contentRevisions.slug,
      status: contentRevisions.status,
      publishAt: contentRevisions.publishAt,
      reason: contentRevisions.reason,
      createdAt: contentRevisions.createdAt,
      actorName: users.name,
    })
    .from(contentRevisions)
    .leftJoin(users, eq(users.id, contentRevisions.actorId))
    .where(eq(contentRevisions.contentId, contentId))
    .orderBy(desc(contentRevisions.createdAt), desc(contentRevisions.id))
    .limit(Math.min(Math.max(1, limit), REVISION_KEEP_CEILING));
  return rows.map((r) => ({ ...r, actorName: r.actorName ?? null }));
}

/** 單筆(含快照)。revisionId 一律與 contentId 綁定查詢,不可跨 content 取用。 */
export async function getRevision(
  contentId: string,
  revisionId: string,
): Promise<RevisionDetail | null> {
  const rows = await db()
    .select({
      id: contentRevisions.id,
      contentId: contentRevisions.contentId,
      type: contentRevisions.type,
      slug: contentRevisions.slug,
      status: contentRevisions.status,
      publishAt: contentRevisions.publishAt,
      reason: contentRevisions.reason,
      createdAt: contentRevisions.createdAt,
      data: contentRevisions.data,
      actorName: users.name,
    })
    .from(contentRevisions)
    .leftJoin(users, eq(users.id, contentRevisions.actorId))
    .where(
      and(
        eq(contentRevisions.contentId, contentId),
        eq(contentRevisions.id, revisionId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    actorName: row.actorName ?? null,
    data: parseSnapshot(row.data),
  };
}
