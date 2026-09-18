import { and, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { recordStatusNotes } from "./schema";
import { isStatusSetRef, STATUS_KEY_RE } from "@/ext/record-status";

// 每一筆紀錄在某個狀態下的描述(migrations/0019;狀態組見 ext/record-status.ts)。
//
// 描述掛在「紀錄 + 狀態」上:說的是這一筆在這個階段的事。紀錄換了狀態,舊階段的
// 描述就不再顯示(回到原狀態時又看得到)。
//
// 插件在 server 端直接呼叫這裡(不必走 HTTP);後台頁面走 /api/record-status/notes。
// 描述只給後台的人看,不參與任何狀態轉移。

export const MAX_STATUS_NOTE = 200;
const MAX_RECORD_ID = 128;
const MAX_BATCH = 200;

export interface StatusNote {
  note: string;
  updatedAt: number;
  updatedBy: string | null;
}

/** 紀錄 id → 狀態 → 描述。 */
export type StatusNotes = Record<string, Record<string, StatusNote>>;

export class StatusNoteError extends Error {}

function assertRef(statusSet: string, recordId: string, status: string): void {
  if (!isStatusSetRef(statusSet)) throw new StatusNoteError("invalid status set");
  if (!recordId || recordId.length > MAX_RECORD_ID) throw new StatusNoteError("invalid record id");
  if (!STATUS_KEY_RE.test(status)) throw new StatusNoteError("invalid status");
}

/** 一批紀錄的描述(每個狀態各一段);沒有描述的紀錄不在回傳裡。 */
export async function getStatusNotes(statusSet: string, recordIds: readonly string[]): Promise<StatusNotes> {
  if (!isStatusSetRef(statusSet)) throw new StatusNoteError("invalid status set");
  const ids = [...new Set(recordIds)].filter((id) => id && id.length <= MAX_RECORD_ID).slice(0, MAX_BATCH);
  if (ids.length === 0) return {};
  const rows = await db()
    .select()
    .from(recordStatusNotes)
    .where(and(eq(recordStatusNotes.statusSet, statusSet), inArray(recordStatusNotes.recordId, ids)));
  const out: StatusNotes = {};
  for (const row of rows) {
    out[row.recordId] = {
      ...out[row.recordId],
      [row.status]: { note: row.note, updatedAt: row.updatedAt, updatedBy: row.updatedBy },
    };
  }
  return out;
}

/** 設定一筆在某個狀態下的描述;空字串或 null = 清除。回傳存下的描述(清除時 null)。 */
export async function setStatusNote(
  statusSet: string,
  recordId: string,
  status: string,
  note: string | null,
  actorId: string | null,
): Promise<StatusNote | null> {
  assertRef(statusSet, recordId, status);
  const text = (note ?? "").trim();
  if (text.length > MAX_STATUS_NOTE) throw new StatusNoteError(`note longer than ${MAX_STATUS_NOTE}`);
  const where = and(
    eq(recordStatusNotes.statusSet, statusSet),
    eq(recordStatusNotes.recordId, recordId),
    eq(recordStatusNotes.status, status),
  );
  if (!text) {
    await db().delete(recordStatusNotes).where(where);
    return null;
  }
  const saved: StatusNote = { note: text, updatedAt: Date.now(), updatedBy: actorId };
  await db()
    .insert(recordStatusNotes)
    .values({ statusSet, recordId, status, ...saved })
    .onConflictDoUpdate({
      target: [recordStatusNotes.statusSet, recordStatusNotes.recordId, recordStatusNotes.status],
      set: saved,
    });
  return saved;
}
