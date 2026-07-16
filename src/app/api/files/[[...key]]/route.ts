import { getFile } from "@/lib/storage";

export const dynamic = "force-dynamic";

// 06 §3:檔案 serving。GET /api/files/<...key>(公開、免登入)。

// Content-Type 白名單:只有這些型別原樣使用,其他一律 application/octet-stream。
// 特別注意 image/svg+xml、text/html 不在白名單(同源 XSS 面)。
const CONTENT_TYPE_WHITELIST = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "application/pdf",
  "text/plain",
]);

/** audio/* 亦在白名單內。 */
function isWhitelisted(contentType: string): boolean {
  const ct = contentType.split(";")[0].trim().toLowerCase();
  if (CONTENT_TYPE_WHITELIST.has(ct)) return true;
  if (ct.startsWith("audio/")) return true;
  return false;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ key?: string[] }> },
): Promise<Response> {
  const { key } = await ctx.params;

  // 1. 讀取端驗證只有兩條:不含 ".."、不以 "/" 開頭。違規 → 400。
  const joined = (key ?? []).join("/");
  if (joined.includes("..") || joined.startsWith("/")) {
    return new Response("bad request", { status: 400 });
  }

  // 2. getFile;null → 404。
  const obj = await getFile(joined);
  if (!obj) {
    return new Response("not found", { status: 404 });
  }

  // 3. headers 是安全邊界,一條不可少。
  const stored = obj.httpMetadata?.contentType ?? "application/octet-stream";
  const whitelisted = isWhitelisted(stored);
  const contentType = whitelisted ? stored : "application/octet-stream";

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "sandbox");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("ETag", obj.httpEtag);
  if (!whitelisted) {
    // 非白名單型別強制下載,不內嵌。
    headers.set("Content-Disposition", "attachment");
  }

  return new Response(obj.body, { headers });
}
