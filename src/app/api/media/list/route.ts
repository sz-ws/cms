import { requireAuth, authErrorResponse } from "@/lib/auth";
import { listFiles } from "@/lib/storage";

export const dynamic = "force-dynamic";

// C.5b §2: admin media library listing. GET /api/media/list?cursor= →
// { files: StoredFile[], cursor?: string }. Read-only, no mutation, so an
// Origin check is not required (matches GET /api/users which is auth-only);
// requireAuth("admin") gates it.
//
// Prefix note: this wraps storage.listFiles("") — the picker's Library tab is a
// GLOBAL media browser (all uploaded files across scopes: core/, posts/, …),
// not one extension's slice. The per-extension ScopedStorage.list (locked to
// `<extId>/`) is deliberately NOT used here; that indirection is too narrow for
// a cross-scope library. R2 list already caps page size at 100 with a cursor.

export async function GET(req: Request): Promise<Response> {
  try {
    await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  const url = new URL(req.url);
  const cursorParam = url.searchParams.get("cursor");
  const cursor = cursorParam && cursorParam.length > 0 ? cursorParam : undefined;

  const { files, cursor: next } = await listFiles("", cursor);
  return Response.json({ files, cursor: next });
}
