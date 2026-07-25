import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { hitRateLimit } from "@/lib/rate-limit";
import { updateFileAlt, MAX_ALT_LENGTH } from "@/lib/storage";

// Media alt text editing. POST /api/media/alt, body { key, alt } → { ok, file }.
// Same guard order as the sibling media mutations (/api/media/delete,
// /api/media/upload): assertSameOrigin → requireAuth("admin") → rate limit,
// because this is a cookie-authenticated mutation.
//
// Storage note: alt lives in the R2 object's customMetadata — no D1 table, no
// migration. updateFileAlt() re-puts the object with its original body (R2 has
// no metadata-only update); see lib/storage.ts for why.

// Key shape produced by lib/storage.ts#makeKey: "<scope>/<yyyy>/<mm>/<nanoid>.<ext>".
// scope = "core" or an extension id: lowercase alnum + dot/dash/underscore.
// Deliberately duplicated from /api/media/delete rather than shared: the two
// routes must be able to tighten independently, and this is the whole guard.
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

  // Phase E §4: rate limit by user.id, 30/min (same budget as delete/upload).
  if (
    await hitRateLimit(user.id, {
      namespace: "media-alt",
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

  const obj = (typeof body === "object" && body !== null ? body : {}) as {
    key?: unknown;
    alt?: unknown;
  };

  if (typeof obj.key !== "string" || obj.key.length === 0) {
    return Response.json({ error: "missing_key" }, { status: 400 });
  }
  if (!isManagedKey(obj.key)) {
    return Response.json({ error: "invalid_key" }, { status: 400 });
  }
  // Empty string is legal: it clears the alt.
  if (typeof obj.alt !== "string") {
    return Response.json({ error: "invalid_alt" }, { status: 400 });
  }
  if (obj.alt.trim().length > MAX_ALT_LENGTH) {
    return Response.json({ error: "alt_too_long" }, { status: 400 });
  }

  const result = await updateFileAlt(obj.key, obj.alt);
  if (!result.ok) {
    return Response.json(
      { error: result.reason },
      { status: result.reason === "not_found" ? 404 : 409 },
    );
  }

  return Response.json({ ok: true, file: result.file });
}
