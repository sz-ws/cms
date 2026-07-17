import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { hitRateLimit } from "@/lib/rate-limit";
import { createServices } from "@/ext/services";
import type { UploadProvider } from "@/ext/capabilities";

// C.5b §2: admin media upload. POST multipart/form-data { file } → stores via
// the active UploadProvider (scope "core") and returns { key, size,
// contentType, url }. Mirrors extensions/posts/api.ts upload handler: 25MB cap,
// pass the File (a Blob with known length) straight to R2. Origin-checked +
// requireAuth("admin") per src/app/api/users/route.ts convention.

const MAX_BYTES = 25 * 1024 * 1024; // 25MB, same as posts upload handler.

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
      namespace: "media-upload",
      limit: 30,
      windowMs: 60_000,
    })
  ) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "invalid_form" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "no_file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: "too_large" }, { status: 413 });
  }

  // Reuse the UploadProvider abstraction (services scope = "core"): storage.put
  // delegates to the active provider's put(), url() to its url().
  const services = await createServices("core");
  const stored = await services.storage.put(
    file.name,
    file,
    file.type || "application/octet-stream",
  );
  const url = services.providers.get<UploadProvider>("upload").url(stored.key);

  return Response.json({ ...stored, url }, { status: 201 });
}
