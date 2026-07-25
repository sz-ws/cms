import { getFile } from "@/lib/storage";
import { getImages } from "@/lib/cf";
import {
  FORMAT_CONTENT_TYPE,
  isTransformableContentType,
  parseVariantRequest,
  variantEtag,
  type VariantRequest,
} from "@/lib/image-variants";

// 06 §3:檔案 serving。GET /api/files/<...key>(公開、免登入)。
//
// 變體:`?w=<寬>&f=<格式>` 在**送出時**縮放/轉檔,R2 裡的原檔一個 byte 都不動。
// 寬度白名單、URL 組法、srcset 都在 src/lib/image-variants.ts,render 端共用同一份。
//
// 降級是這條路徑的第一原則。轉換靠 env.IMAGES binding(需帳號開通 Cloudflare
// Images)。binding 不在、或轉換丟錯(未開通、來源不是圖、超過 binding 的 20MB
// 上限…),一律**原樣送原檔** —— 絕不 404、絕不 500。這個 repo 是 scaffold,部署
// 的人很可能沒開那個功能;那時網站該照常有圖,只是圖比較大。
//
// 為什麼不用 /cdn-cgi/image/:那是 zone 層級功能,要求網域掛在 Cloudflare 且該
// zone 已啟用 transformations。`*.workers.dev` 不是客戶 zone,而 DEPLOY.md 的預設
// 部署形態就沒有自訂網域 —— 對這個 repo 的預設情境等於不可用。binding 走 Worker
// 內部,不受 zone 限制,所以是唯一對 scaffold 成立的選擇。

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

/** X-Image-Transform 的取值。診斷用:curl -I 就能看出變體有沒有真的生效。 */
type TransformState = "none" | "applied" | "unavailable";

/**
 * 送出用的 headers。變體與原檔共用同一組 —— 轉換不是放寬安全邊界的理由,
 * nosniff / CSP sandbox / immutable 一條都不能少。
 */
function buildHeaders(opts: {
  contentType: string;
  etag: string;
  attachment: boolean;
  transform: TransformState;
}): Headers {
  const headers = new Headers();
  headers.set("Content-Type", opts.contentType);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "sandbox");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("ETag", opts.etag);
  headers.set("X-Image-Transform", opts.transform);
  if (opts.attachment) {
    // 非白名單型別強制下載,不內嵌。
    headers.set("Content-Disposition", "attachment");
  }
  return headers;
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

  // 4. 變體。先看 binding 在不在,**再**決定要不要碰 body —— 順序是刻意的:
  //    images.input() 會鎖住 obj.body,一旦鎖了就沒辦法再拿它送原檔。binding
  //    不存在(最常見的降級情境)時整段跳過,原檔路徑零額外成本。
  const variant = parseVariantRequest(new URL(req.url).searchParams);
  const images = getImages();
  if (
    variant &&
    images &&
    whitelisted &&
    isTransformableContentType(contentType)
  ) {
    // binding 在,但帳號未必開通 —— 這裡才需要把 body 收成 buffer,好讓轉換失敗
    // 時還有東西可以送。上傳端上限 25MB(/api/media/upload),在 Workers 記憶體
    // 預算內;同 lib/storage.ts#updateFileAlt 的取捨。
    const bytes = await obj.arrayBuffer();
    const transformed = await transformResponse(
      images,
      bytes,
      obj.httpEtag,
      variant,
    );
    if (transformed) return transformed;
    return new Response(bytes, {
      headers: buildHeaders({
        contentType,
        etag: obj.httpEtag,
        attachment: false,
        transform: "unavailable",
      }),
    });
  }

  return new Response(obj.body, {
    headers: buildHeaders({
      contentType,
      etag: obj.httpEtag,
      attachment: !whitelisted,
      transform: "none",
    }),
  });
}

/**
 * 轉一張圖。回傳 null = 轉不動,呼叫端負責送原檔。
 *
 * 這個函式**不會 throw**:帳號沒開通 Images、來源不是圖、超過 20MB 上限 ——
 * 全部收斂成 null。
 */
async function transformResponse(
  images: ImagesBinding,
  bytes: ArrayBuffer,
  sourceEtag: string,
  req: VariantRequest,
): Promise<Response | null> {
  const format = req.format;
  if (!format) return null;
  const contentType = FORMAT_CONTENT_TYPE[format];

  try {
    const source = new Response(bytes).body;
    if (!source) return null;
    let handle = images.input(source);
    if (req.width !== undefined) {
      // fit: "scale-down" —— 只縮不放。原圖比 w 窄時原樣輸出,不會被拉糊。
      handle = handle.transform({ width: req.width, fit: "scale-down" });
    }
    const result = await handle.output({ format: contentType });
    const body = result.response().body;
    if (!body) return null;
    return new Response(body, {
      headers: buildHeaders({
        contentType,
        // 「原檔 etag + 變體參數」:原檔一換,所有變體的 etag 跟著換。
        etag: variantEtag(sourceEtag, req),
        attachment: false,
        transform: "applied",
      }),
    });
  } catch {
    return null;
  }
}
