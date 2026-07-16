import { requireAuth, authErrorResponse } from "@/lib/auth";
import { hitRateLimit } from "@/lib/rate-limit";
import {
  assertKnownRegistrySource,
  fetchExtensionAssetBytes,
  UnknownRegistrySource,
} from "@/lib/registry-client";
import { EXTENSION_ID_RE, assetContentType, isValidAssetFile } from "@/lib/registry-asset";

export const dynamic = "force-dynamic";

const ASSET_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";

/** 錯誤回應一律 no-store(見下方檔案註解)。 */
function errorResponse(body: unknown, status: number): Response {
  return withNoStore(Response.json(body, { status }));
}

function withNoStore(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, headers });
}

/**
 * If-None-Match 可能是逗號分隔的多個 entity-tag 或 "*"(比對任何值)。這裡不
 * 特別處理 weak(W/ 前綴)語意差異 —— 對這支「純代理靜態圖片」route 而言,
 * upstream etag 值不變就代表 bytes 不變,直接比對整個 tag 字串已足夠。
 */
function etagMatches(ifNoneMatch: string, etag: string): boolean {
  return ifNoneMatch
    .split(",")
    .map((s) => s.trim())
    .some((tag) => tag === "*" || tag === etag);
}

// GET /api/registry/asset?source=...&id=...&file=...。admin only。
//
// Marketplace media (iconUrl / banner / screenshots) 的 server-side proxy。
// registry source 可能是 private repo(token 存在 server-side 的
// core.registryTokens),瀏覽器的 <img> 沒辦法自己帶那個 token 去打
// `<source>/extensions/<id>/<file>`,只會拿到 401/303 —— 所以 RegistryBrowser
// 改成打這支 route,由伺服器帶 token 抓,再把 bytes 轉手給瀏覽器。
//
// 與 manifest route 共用 auth / SSRF-guard 形狀(admin-only、
// assertKnownRegistrySource、unknown_source 400),但多了一層 file 白名單
// (registry-asset.ts:單一路徑段、不含 ".."、副檔名限圖片)。Content-Type 一律
// 從檔名副檔名推導,絕不信任 upstream response header(第三方 registry 可能
// 謊報 content-type 夾帶可執行內容)。svg 額外加 CSP header 中和潛在的內嵌
// script(<img> 標籤本身不會執行 SVG 內的 script,但這裡多一層防線,防這個
// response 被直接開啟或用 <object>/<iframe> 嵌入)。
//
// 快取:成功回應標準 public/max-age=3600 + stale-while-revalidate=86400(這支
// route 量級比 manifest 高,見下方 rate limit 註解,值得讓 CDN/瀏覽器快取減壓)。
// 錯誤回應一律 no-store(guard 失敗/上游失敗都不該被快取,否則暫時性上游錯誤
// 會卡住直到快取過期)。ETag:單純轉發 upstream 原始 header(可能沒有,不同
// registry 來源不保證附),沒有就不設;不自行合成 hash 當替代 ETag(§5:不加
// 沒有安全/正確性需求的複雜度)。目前不做「conditional forwarding」——一律照常
// 打上游拿 bytes,只在拿到的 etag 與 client 帶來的 If-None-Match 相符時把 200
// 換成 304,省的是「瀏覽器再解一次圖」而非「打一次上游」。
export async function GET(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return withNoStore(r);
    throw e;
  }

  // 圖片代理量級比 manifest preview 高(一個 marketplace 頁面可能同時載入
  // icon + banner + 多張 screenshots),給寬鬆一點的上限：120/min per user。
  if (
    await hitRateLimit(user.id, {
      namespace: "registry-asset",
      limit: 120,
      windowMs: 60_000,
    })
  ) {
    return errorResponse({ error: "rate_limited" }, 429);
  }

  const url = new URL(req.url);
  const source = url.searchParams.get("source");
  const id = url.searchParams.get("id");
  const file = url.searchParams.get("file");
  if (!source || !id || !file) {
    return errorResponse({ error: "invalid_input" }, 400);
  }

  if (!EXTENSION_ID_RE.test(id)) {
    return errorResponse({ error: "invalid_id" }, 400);
  }

  // 白名單先過:單一路徑段、不含 ".."、副檔名在圖片白名單內。安全 Content-Type
  // 也是從這裡推導 —— 一定要在真的去 fetch 之前就決定好,不能讓 upstream
  // response 反過來影響我們回什麼 header。
  const contentType = assetContentType(file);
  if (!isValidAssetFile(file) || !contentType) {
    return errorResponse({ error: "invalid_file" }, 400);
  }

  // SSRF guard(§5):source 必須完全等於已設定的 core.registrySources 其中一個。
  try {
    await assertKnownRegistrySource(source);
  } catch (e) {
    if (e instanceof UnknownRegistrySource) {
      return errorResponse({ error: "unknown_source" }, 400);
    }
    throw e;
  }

  let bytes: Uint8Array;
  let etag: string | null;
  try {
    ({ bytes, etag } = await fetchExtensionAssetBytes(source, id, file));
  } catch (e) {
    return errorResponse(
      {
        error: "asset_fetch_failed",
        message: e instanceof Error ? e.message : "unknown error",
      },
      502,
    );
  }

  const ifNoneMatch = req.headers.get("if-none-match");
  if (etag && ifNoneMatch && etagMatches(ifNoneMatch, etag)) {
    // 304:不重送 body,但快取相關 header 照給,讓瀏覽器續用本地副本。
    const headers = new Headers();
    headers.set("Cache-Control", ASSET_CACHE_CONTROL);
    headers.set("ETag", etag);
    return new Response(null, { status: 304, headers });
  }

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", ASSET_CACHE_CONTROL);
  if (etag) headers.set("ETag", etag);
  if (contentType === "image/svg+xml") {
    // 中和被腳本化的 SVG:即使有人繞過上面的白名單直接打這支 route 拿到
    // svg,回應本身也不准跑任何 script / 載入任何外部資源。
    headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
  }

  // `bytes` is always a freshly-constructed, exactly-sized Uint8Array (see
  // boundedFetchBytes) — byteOffset 0, byteLength === buffer.byteLength — so
  // `.buffer` is safe to hand to Response as-is. The cast works around TS's
  // Uint8Array<ArrayBufferLike> vs BodyInit's ArrayBuffer mismatch.
  return new Response(bytes.buffer as ArrayBuffer, { headers });
}
