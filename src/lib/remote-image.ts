import { sniffImageFormat, type ImageFormat } from "./image-dimensions";

// AI 上傳圖片的兩個來源(src/ext/agent-tools-media.ts 的 core.media.upload):
//   * 網址 —— 由站台自己去抓(伺服器端 fetch)。
//   * base64 —— 呼叫端直接給檔案內容。
// 兩者最後都變成「一串 byte + 從 byte 認出來的格式」,再交給媒體庫的同一支存檔函式。
//
// ── 抓網址的防線 ───────────────────────────────────────────────────────────
// 網址是 AI 給的,而 AI 的輸入可能來自任何地方(網頁、客人留言)。所以:
//   1. 只收 http / https;網址裡不能帶帳號密碼(使用者資訊常是憑證外洩,也是 SSRF 的
//      老把戲 `https://good@evil/`)。
//   2. 主機名不能是本機、區網或保留位址(字面判斷)。Worker 有 global_fetch_strictly_public
//      (wrangler.jsonc),DNS 解析到私有位址的請求本來就出不去;這裡是在那之前先擋掉
//      寫得出來的那些,錯誤訊息也比較清楚。
//   3. 轉址自己跟(redirect: "manual"),每一跳都重驗 1、2 —— 否則一個公開網址 302 到
//      http://127.0.0.1/ 就繞過了。最多 3 跳。
//   4. 整趟(含讀 body)有逾時;大小先看 Content-Length,再邊讀邊數,超過就中斷。
//   5. 格式看檔頭(sniffImageFormat),不看 Content-Type。

/** 整趟抓取(連線、轉址、讀完 body)的上限。 */
const REMOTE_IMAGE_TIMEOUT_MS = 15_000;
/** 最多跟幾次轉址。 */
const REMOTE_IMAGE_MAX_REDIRECTS = 3;
/** 網址長度上限。 */
export const REMOTE_IMAGE_URL_MAX = 2048;

export type ImageSourceErrorCode =
  | "url_not_allowed"
  | "fetch_failed"
  | "timeout"
  | "too_large"
  | "not_an_image"
  | "invalid_base64";

/** 給模型看的錯誤:`<code>: <說明>`。invokeAgentTool 會把 message 原樣回給模型(截 200 字)。 */
export class ImageSourceError extends Error {
  readonly code: ImageSourceErrorCode;
  constructor(code: ImageSourceErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ImageSourceError";
    this.code = code;
  }
}

export interface ImageBytes {
  bytes: Uint8Array<ArrayBuffer>;
  format: ImageFormat;
}

const SUPPORTED = "JPEG, PNG, GIF, WebP or AVIF";

// ---------------------------------------------------------------------------
// 網址檢查
// ---------------------------------------------------------------------------

/** 不對外的主機名後綴(本機、mDNS、區網慣用名)。 */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".localdomain"];

function ipv4Octets(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? octets : null;
}

/** 私有、本機、link-local、CGNAT、保留與多播位址。 */
function isNonPublicIpv4([a, b]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * IPv6 字面位址只放行 global unicast(2000::/3)。其餘(::1、::、fc00::/7、fe80::/10、
 * ::ffff:<IPv4> 映射…)一律擋 —— 一張商品照沒有理由放在那些位址上。
 */
function isNonPublicIpv6(bracketed: string): boolean {
  const inner = bracketed.slice(1, -1).toLowerCase();
  const first = inner.split(":")[0];
  if (!/^[0-9a-f]{1,4}$/.test(first)) return true;
  const value = parseInt(first, 16);
  return value < 0x2000 || value > 0x3fff;
}

function isBlockedHost(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/\.$/, "");
  if (hostname.startsWith("[")) return isNonPublicIpv6(hostname);
  const v4 = ipv4Octets(hostname);
  if (v4) return isNonPublicIpv4(v4);
  if (hostname === "localhost") return true;
  if (PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return true;
  // 單一標籤(http://intranet/、http://metadata/)只在內網解析得到。
  return !hostname.includes(".");
}

/** 驗一個網址能不能抓;不行就 throw url_not_allowed。WHATWG URL 會把 2130706433 之類正規化成點分位址。 */
function checkImageUrl(raw: string): URL {
  if (raw.length > REMOTE_IMAGE_URL_MAX) {
    throw new ImageSourceError("url_not_allowed", "the address is too long");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ImageSourceError("url_not_allowed", "not a valid web address");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ImageSourceError("url_not_allowed", "only http and https addresses can be fetched");
  }
  if (url.username || url.password) {
    throw new ImageSourceError("url_not_allowed", "the address contains a username or password");
  }
  if (isBlockedHost(url.hostname)) {
    throw new ImageSourceError("url_not_allowed", `${url.hostname} is a private or local address`);
  }
  return url;
}

// ---------------------------------------------------------------------------
// 抓取
// ---------------------------------------------------------------------------

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // 已經讀完或已關閉:沒有東西要丟。
  }
}

/** 邊讀邊數;超過上限就中斷連線,不把整份讀進記憶體。 */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new ImageSourceError("too_large", `the file is larger than ${formatMb(maxBytes)}`);
  if (!res.body) {
    const whole = new Uint8Array(await res.arrayBuffer());
    if (whole.byteLength > maxBytes) throw tooLarge();
    return whole;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function identify(bytes: Uint8Array<ArrayBuffer>, where: string): ImageBytes {
  const format = sniffImageFormat(bytes.subarray(0, 64));
  if (!format) {
    throw new ImageSourceError("not_an_image", `${where} is not a ${SUPPORTED} image`);
  }
  return { bytes, format };
}

export interface FetchRemoteImageOptions {
  maxBytes: number;
  timeoutMs?: number;
  /** 測試注入用;省略 = 全域 fetch(呼叫當下讀取)。 */
  fetchImpl?: typeof fetch;
}

async function fetchFollowingRedirects(
  start: URL,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<Response> {
  let current = start;
  for (let hop = 0; hop <= REMOTE_IMAGE_MAX_REDIRECTS; hop++) {
    const res = await fetchImpl(current.toString(), {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1" },
    });
    if (!REDIRECT_STATUSES.has(res.status)) return res;
    const location = res.headers.get("location");
    await discardBody(res);
    if (!location) {
      throw new ImageSourceError("fetch_failed", `HTTP ${res.status} without a Location header`);
    }
    // 每一跳都重驗:公開網址轉到私有位址是這一關要擋的主要情形。
    current = checkImageUrl(new URL(location, current).toString());
  }
  throw new ImageSourceError("fetch_failed", `more than ${REMOTE_IMAGE_MAX_REDIRECTS} redirects`);
}

/** 抓一張網路上的圖。所有失敗都是 ImageSourceError。 */
export async function fetchRemoteImage(rawUrl: string, options: FetchRemoteImageOptions): Promise<ImageBytes> {
  const start = checkImageUrl(rawUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS);
  try {
    const res = await fetchFollowingRedirects(start, signal, fetchImpl);
    if (!res.ok) {
      await discardBody(res);
      throw new ImageSourceError("fetch_failed", `the address answered HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      await discardBody(res);
      throw new ImageSourceError("too_large", `the file is larger than ${formatMb(options.maxBytes)}`);
    }
    return identify(await readCapped(res, options.maxBytes), "the file at that address");
  } catch (e) {
    if (e instanceof ImageSourceError) throw e;
    // AbortSignal.timeout 丟的是 DOMException;不假設它 instanceof Error。
    const name = typeof e === "object" && e !== null && "name" in e ? String(e.name) : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ImageSourceError("timeout", `no complete answer within ${Math.round((options.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS) / 1000)} seconds`);
    }
    const detail = e instanceof Error ? e.message : String(e);
    throw new ImageSourceError("fetch_failed", detail.slice(0, 120));
  }
}

// ---------------------------------------------------------------------------
// base64
// ---------------------------------------------------------------------------

const DATA_URL_RE = /^data:[^,]*?;base64,/i;

/** base64 字元數上限:maxBytes 的編碼長度,加一點給 data: 前綴與換行。 */
export function base64MaxChars(maxBytes: number): number {
  return Math.ceil(maxBytes / 3) * 4 + 1024;
}

/** base64(或 data: URL)→ byte。空白與換行略過;base64url 也收。 */
export function decodeBase64Image(raw: string, maxBytes: number): ImageBytes {
  let text = raw.trim();
  if (text.startsWith("data:")) {
    if (!DATA_URL_RE.test(text)) {
      throw new ImageSourceError("invalid_base64", "a data: URL must be base64-encoded");
    }
    text = text.replace(DATA_URL_RE, "");
  }
  text = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 === 1) {
    throw new ImageSourceError("invalid_base64", "the data is not valid base64");
  }
  const unpadded = text.replace(/=+$/, "");
  const size = Math.floor((unpadded.length * 3) / 4);
  if (size > maxBytes) {
    throw new ImageSourceError("too_large", `the file is larger than ${formatMb(maxBytes)}`);
  }
  let binary: string;
  try {
    binary = atob(unpadded.padEnd(unpadded.length + ((4 - (unpadded.length % 4)) % 4), "="));
  } catch {
    throw new ImageSourceError("invalid_base64", "the data is not valid base64");
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return identify(bytes, "the data");
}
