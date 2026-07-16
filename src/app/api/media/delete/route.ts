import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { hitRateLimit } from "@/lib/rate-limit";
import { deleteFile } from "@/lib/storage";

export const dynamic = "force-dynamic";

// Task #7 §1: admin media deletion — the gap left by C.5b (upload + list only).
// POST /api/media/delete, body { key }. Mirrors the upload route's guard order
// (assertSameOrigin → requireAuth("admin")) since this is a cookie-authenticated
// mutation. deleteFile() is the same lib/storage.ts primitive the ext services
// layer (ScopedStorage.delete) and providers.ts wrap — called directly here
// because this is a core admin action, not an extension-scoped one.

// Key shape produced by lib/storage.ts#makeKey: "<scope>/<yyyy>/<mm>/<nanoid>.<ext>".
// scope = "core" or an extension id: lowercase alnum + dot/dash/underscore.
const KEY_RE = /^[a-z0-9._-]+\/\d{4}\/\d{2}\/[A-Za-z0-9_-]+\.[a-z0-9]{1,8}$/;

/** Reject anything that isn't exactly the managed key shape — no traversal,
 * no absolute paths, no reaching outside the yyyy/mm scoped prefixes. */
function isManagedKey(key: string): boolean {
  if (key.includes("..") || key.startsWith("/")) return false;
  return KEY_RE.test(key);
}

export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    const r = originErrorResponse(e);
    if (r) return r;
    throw e;
  }

  let user;
  try {
    user = await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  // Phase E §4: rate limit by user.id, 30/min.
  if (
    await hitRateLimit(user.id, {
      namespace: "media-delete",
      limit: 30,
      windowMs: 60_000,
    })
  ) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const key =
    typeof body === "object" && body !== null && "key" in body
      ? (body as { key: unknown }).key
      : undefined;

  if (typeof key !== "string" || key.length === 0) {
    return Response.json({ error: "missing_key" }, { status: 400 });
  }
  if (!isManagedKey(key)) {
    return Response.json({ error: "invalid_key" }, { status: 400 });
  }

  await deleteFile(key);
  return Response.json({ ok: true });
}

// DELETE is accepted as an alias so callers that prefer the verb over a body-only
// POST (e.g. a future fetch(url, { method: "DELETE" }) with ?key=) still work.
export async function DELETE(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    const r = originErrorResponse(e);
    if (r) return r;
    throw e;
  }

  let user;
  try {
    user = await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  // Phase E §4: rate limit by user.id, 30/min.
  if (
    await hitRateLimit(user.id, {
      namespace: "media-delete",
      limit: 30,
      windowMs: 60_000,
    })
  ) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const url = new URL(req.url);
  const key = url.searchParams.get("key") ?? "";
  if (key.length === 0) {
    return Response.json({ error: "missing_key" }, { status: 400 });
  }
  if (!isManagedKey(key)) {
    return Response.json({ error: "invalid_key" }, { status: 400 });
  }

  await deleteFile(key);
  return Response.json({ ok: true });
}
