import { and, eq, ne } from "drizzle-orm";
import { db } from "./db";
import { contents } from "./schema";
import { captureRevision, getRevision } from "./revisions";
import { indexContentEntry } from "./search";
import { revalidateContent } from "@/ext/dx/cache-invalidate";

// 版本還原(undo)。從 ./revisions 拆出來的理由只有一個:那支模組是「擷取 / 保留 /
// 讀取」的資料層,而還原是**寫入**動作,得自己補齊 provider 寫入路徑的副作用清單
// (hook / FTS / cache 失效),兩件事混在一個檔案裡會超過本專案的單檔長度慣例。
// 契約與設計理由見 ./revisions 檔頭。

export class RevisionRestoreError extends Error {
  constructor(readonly code: "not_found" | "type_mismatch") {
    super(code);
    this.name = "RevisionRestoreError";
  }
}

export interface RestoreResult {
  id: string;
  type: string;
  slug: string | null;
  status: string;
  publishAt: number | null;
  data: Record<string, unknown>;
  updatedAt: number;
  /** 快照的 slug 已被同型別的其他項目佔用,故沿用目前的 slug(見下方註解)。 */
  slugKept: boolean;
}

/**
 * 還原:把快照原樣寫回 content row,並補齊 provider 寫入路徑的三個副作用
 * (hook / FTS / cache 失效),然後為「還原後的狀態」再記一筆 reason="restore" 的版本。
 *
 * 為何不走 CoreContentProvider.update():
 *   1. update() 是 **merge** 語意({...existing.data, ...patch}),還原需要的是 **replace**
 *      —— 舊版本刪掉的欄位不能因為 merge 又活過來。
 *   2. update() 會以「當下的 manifest」重跑欄位驗證。manifest 是會演進的;因為欄位定義
 *      後來變嚴了就讓使用者按不了 undo,是本末倒置。快照寫入當下已驗過。這與 jobs.ts
 *      的 publish-due 刻意不重跑驗證是同一個判斷。
 * 代價是這裡必須自己列出副作用清單(下方),與 provider 保持同步。
 *
 * slug:快照的 slug 若已被同型別的其他項目佔用,partial unique index 會擋下整次更新。
 * 這種情況保留目前的 slug(內容照還原),並在回傳值標記 slugKept —— 寧可少還原一個
 * 路由用欄位,也不要讓 undo 整個失敗。
 */
export async function restoreRevision(
  contentId: string,
  revisionId: string,
  opts: { actorId?: string | null; now?: number } = {},
): Promise<RestoreResult> {
  const revision = await getRevision(contentId, revisionId);
  if (!revision) throw new RevisionRestoreError("not_found");

  const current = await db()
    .select({
      id: contents.id,
      type: contents.type,
      locale: contents.locale,
      slug: contents.slug,
    })
    .from(contents)
    .where(eq(contents.id, contentId))
    .limit(1);
  const row = current[0];
  if (!row) throw new RevisionRestoreError("not_found");
  // 版本的 type 必須與 content row 現況一致(擋跨型別誤用;理論上不會發生)。
  if (row.type !== revision.type) {
    throw new RevisionRestoreError("type_mismatch");
  }

  const now = opts.now ?? Date.now();

  // slug 佔用檢查(見 doc comment)。
  let slug = revision.slug;
  let slugKept = false;
  if (slug !== null && slug !== row.slug) {
    const clash = await db()
      .select({ id: contents.id })
      .from(contents)
      .where(
        and(
          eq(contents.type, row.type),
          eq(contents.slug, slug),
          ne(contents.id, contentId),
        ),
      )
      .limit(1);
    if (clash.length > 0) {
      slug = row.slug;
      slugKept = true;
    }
  }

  const data = revision.data;
  await db()
    .update(contents)
    .set({
      slug,
      status: revision.status,
      publishAt: revision.publishAt,
      data: JSON.stringify(data),
      updatedAt: now,
    })
    .where(eq(contents.id, contentId));

  // ---- provider 寫入路徑的副作用(全部 best-effort,同 CoreContentProvider 哲學)----
  try {
    const { getExtRuntime } = await import("@/ext/loader");
    const rt = await getExtRuntime();
    await rt.hooks.doAction("content:updated", {
      type: row.type,
      id: contentId,
      data,
    });
  } catch (e) {
    console.error("[revisions] restore hook dispatch failed", contentId, e);
  }
  try {
    await indexContentEntry(contentId, row.type, row.locale, data);
  } catch (e) {
    console.error("[revisions] restore reindex failed", contentId, e);
  }
  revalidateContent(row.type);

  // 還原後的狀態自己也是一個版本:被還原掉的壞版本仍留在列表裡(undo 可 redo)。
  await captureRevision({
    contentId,
    type: row.type,
    slug,
    status: revision.status,
    publishAt: revision.publishAt,
    data,
    reason: "restore",
    actorId: opts.actorId,
    now,
  });

  return {
    id: contentId,
    type: row.type,
    slug,
    status: revision.status,
    publishAt: revision.publishAt,
    data,
    updatedAt: now,
    slugKept,
  };
}
