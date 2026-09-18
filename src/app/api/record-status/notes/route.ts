import { z } from "zod";
import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { readBoundedJsonObject } from "@/lib/body-limit";
import {
  getStatusNotes,
  MAX_STATUS_NOTE,
  setStatusNote,
  StatusNoteError,
} from "@/lib/record-status-notes";

// 1.40.0:每一筆紀錄在某個狀態下的描述(lib/record-status-notes.ts)。
//
//   GET /api/record-status/notes?set=<extId>:<setId>&ids=a,b,c
//       → { notes: { <id>: { <status>: { note, updatedAt, updatedBy } } } }
//   PUT /api/record-status/notes { set, id, status, note }
//       → { ok, note }(note 空 = 清除這一筆在這個狀態下的描述)
//
// 給後台頁面呼叫:admin session、同源檢查。set 必須是啟用中的 extension 宣告過的
// 狀態組,status 必須是那一組裡的狀態 —— 不讓端點變成一張能塞任意 key 的表。
// 插件在 server 端直接呼叫 lib 函式即可。

async function declaredSets(): Promise<Map<string, Set<string>>> {
  const { getExtRuntime } = await import("@/ext/loader");
  const rt = await getExtRuntime();
  return new Map(
    rt.enabled.flatMap((ext) =>
      (ext.statusSets ?? []).map((set) => [`${ext.id}:${set.id}`, new Set(Object.keys(set.statuses))] as const),
    ),
  );
}

async function admin(): Promise<{ id: string } | Response> {
  try {
    return await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }
}

const unknownSet = () => Response.json({ error: "unknown_status_set" }, { status: 404 });
const invalid = () => Response.json({ error: "invalid_input" }, { status: 400 });

export async function GET(req: Request): Promise<Response> {
  const actor = await admin();
  if (actor instanceof Response) return actor;
  const params = new URL(req.url).searchParams;
  const set = params.get("set") ?? "";
  const ids = (params.get("ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (!(await declaredSets()).has(set)) return unknownSet();
  try {
    return Response.json({ notes: await getStatusNotes(set, ids) });
  } catch (e) {
    if (e instanceof StatusNoteError) return invalid();
    throw e;
  }
}

const bodySchema = z
  .object({
    set: z.string(),
    id: z.string().min(1).max(128),
    status: z.string().min(1).max(64),
    note: z.string().max(MAX_STATUS_NOTE).nullable(),
  })
  .strict();

export async function PUT(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    const r = originErrorResponse(e);
    if (r) return r;
    throw e;
  }
  const actor = await admin();
  if (actor instanceof Response) return actor;

  const raw = await readBoundedJsonObject(req, 4096, "record-status-notes");
  if (!raw.ok) {
    return Response.json({ error: "invalid_input" }, { status: raw.reason === "too_large" ? 413 : 400 });
  }
  const body = bodySchema.safeParse(raw.value);
  if (!body.success) return invalid();
  const { set, id, status, note } = body.data;
  const statuses = (await declaredSets()).get(set);
  if (!statuses) return unknownSet();
  if (!statuses.has(status)) return Response.json({ error: "unknown_status" }, { status: 400 });
  try {
    return Response.json({ ok: true, note: await setStatusNote(set, id, status, note, actor.id) });
  } catch (e) {
    if (e instanceof StatusNoteError) return invalid();
    throw e;
  }
}
