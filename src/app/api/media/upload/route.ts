import { authErrorResponse } from "@/lib/auth";
import { requireMediaAccess } from "@/lib/access-api";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { hitRateLimit } from "@/lib/rate-limit";
import { MEDIA_UPLOAD_MAX_BYTES, saveMediaUpload } from "@/lib/media-upload";
import { createServices } from "@/ext/services";

// C.5b §2: admin media upload. POST multipart/form-data { file } → stores via
// services.storage (scope "core") and returns { key, size, contentType, url }.
// Mirrors extensions/posts/api.ts upload handler: 25MB cap, pass the File (a
// Blob with known length) straight to R2. Origin-checked +
// requireAuth("admin") per src/app/api/users/route.ts convention.
//
// 1.60.0: the store step is lib/media-upload.ts#saveMediaUpload, shared with
// the AI upload tool (core.media.upload) so both write identical files.

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
    user = await requireMediaAccess("upload");
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
  if (file.size > MEDIA_UPLOAD_MAX_BYTES) {
    return Response.json({ error: "too_large" }, { status: 413 });
  }

  const services = await createServices("core");
  const saved = await saveMediaUpload(services, {
    filename: file.name,
    body: file,
    contentType: file.type || "application/octet-stream",
  });

  return Response.json(saved, { status: 201 });
}
