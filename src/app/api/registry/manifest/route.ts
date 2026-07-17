import { requireAuth, authErrorResponse } from "@/lib/auth";
import { hitRateLimit } from "@/lib/rate-limit";
import {
  assertKnownRegistrySource,
  fetchManifest,
  UnknownRegistrySource,
} from "@/lib/registry-client";
import { parseManifest } from "@/ext/dx/manifest";

// GET /api/registry/manifest?source=...&id=...。admin only。
// 供 install 表單「安裝前預覽」用:抓 manifest 並驗證,回傳 installPrompts(若有)
// 給前端渲染表單,不做任何寫入 —— 與 POST /api/registry/install 共用 fetch +
// parse 邏輯,但完全唯讀。錯誤形狀比照 install route(unknown_source /
// invalid_manifest / manifest_fetch_failed)方便前端共用 error 文案。
export async function GET(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  // admin-only 唯讀 preview,但仍會對外 fetch 一次 manifest —— 比照 install
  // route 的量級掛個溫和上限(60/min per user)。
  if (
    await hitRateLimit(user.id, {
      namespace: "registry-manifest",
      limit: 60,
      windowMs: 60_000,
    })
  ) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const url = new URL(req.url);
  const source = url.searchParams.get("source");
  const id = url.searchParams.get("id");
  if (!source || !id) {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  try {
    await assertKnownRegistrySource(source);
  } catch (e) {
    if (e instanceof UnknownRegistrySource) {
      return Response.json({ error: "unknown_source" }, { status: 400 });
    }
    throw e;
  }

  let rawManifest: unknown;
  try {
    rawManifest = await fetchManifest(source, id);
  } catch (e) {
    return Response.json(
      {
        error: "manifest_fetch_failed",
        message: e instanceof Error ? e.message : "unknown error",
      },
      { status: 502 },
    );
  }

  const result = parseManifest(rawManifest);
  if (!result.ok || !result.manifest) {
    return Response.json(
      { error: "invalid_manifest", message: result.error },
      { status: 400 },
    );
  }

  return Response.json({ manifest: result.manifest });
}
