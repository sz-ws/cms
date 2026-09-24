// [core] Content-Security-Policy 的組法。零依賴:next.config.ts(Node 在建置期載入)
// 與 middleware(edge,每個公開頁請求)都 import 這一份,所以兩邊的指令不可能分叉。
//
// ## 兩種頁面、兩種待遇(1.50.0)
//
// 後台、登入、/api:維持 Report-Only(reportOnlyPolicy() 不帶 nonce)。後台有
// QuickJS 沙盒、後台字體、大量 inline style,還沒有收乾淨的依據。
//
// 公開頁:middleware 每個請求產生一次 nonce,送出**兩個**標頭 ——
//
//   Content-Security-Policy(enforce):只管會執行程式的東西。
//     script-src 'self' 'nonce-…' + 核准過的宣告式 script 的主機
//     object-src 'none'; base-uri 'self'; frame-ancestors 'none'
//   Content-Security-Policy-Report-Only:完整的目標 policy(圖片、字體、連線、表單…),
//     同一個 nonce 與主機。繼續收違規,作為哪天把其餘指令也改成 enforce 的依據。
//
// 為什麼 enforce 只收 script 那幾條:XSS 能做的事全靠「執行程式」;圖片、字體、表單
// 目標被擋只會讓頁面缺東西,而公開頁今天就有擋了會壞的真實流量 —— 結帳把表單 POST 到
// 金流閘道(form-action 'self' 會把付款整個擋掉),內容裡可能有外站圖片。那些要先從
// Report-Only 的收件裡確認乾淨,不是推論。
//
// 為什麼是 nonce 而不是 'unsafe-inline':Next.js 的 hydration 與 RSC payload 本身
// 就是 inline script。Next 會從**請求**的 Content-Security-Policy 標頭抓 nonce、蓋到
// 它自己的每一個 script 上(app-render 的 getScriptNonceFromHeader),所以 middleware
// 把 policy 同時寫進請求與回應。整站 force-dynamic(見 app/layout.tsx),每個公開頁
// 都是逐請求渲染,不會有沒帶 nonce 的預先產生頁面。
//
// 為什麼不用 'strict-dynamic':它會讓被信任的 script 再載入任何主機的 script,
// 並忽略主機白名單 —— 而宣告式插件核准畫面上的 `domains` 正是「這段 script 會連到
// 哪裡」的承諾。沒有 strict-dynamic,核准過的 script 只能從列出的主機再載入程式。

/** CSP 違規回報的收件端點(src/app/api/csp-report/route.ts)。 */
export const CSP_REPORT_URI = "/api/csp-report";

// host-source 只收這個形狀:可選的 `*.` 萬用子網域 + 至少兩段的網域 + 可選的連接埠。
// 值來自資料庫裡的 manifest(安裝時已經驗過),但它會原樣寫進回應標頭 —— 一個空白或
// 分號就能多塞一條指令,所以寫進去之前再擋一次。
const HOST_RE = /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?$/;
const NONCE_RE = /^[A-Za-z0-9+/_-]{16,64}={0,2}$/;

/** 主機 → `https://主機`(去重、丟掉任何不合規的值)。 */
export function cspHostSources(hosts: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of hosts) {
    const host = raw.trim().toLowerCase();
    if (!HOST_RE.test(host)) continue;
    const source = `https://${host}`;
    if (!out.includes(source)) out.push(source);
  }
  return out;
}

/** 網址 → 它的 origin(給 connect-src 用);不是 https 網址就回 null。 */
export function cspOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && HOST_RE.test(parsed.host) ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** 每個請求一個:16 bytes 隨機值,base64。 */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export interface PublicPolicyInput {
  nonce: string;
  /** 核准過的宣告式 script 會用到的主機(src 的主機 + domains)。 */
  hosts: readonly string[];
  /** 開發模式:React 與 Next 的開發工具需要 eval,HMR 走 websocket。 */
  dev?: boolean;
  /** 前端錯誤回報的 DSN(建置期的 NEXT_PUBLIC_CMS_ERROR_DSN),它的 origin 要能連。 */
  errorDsn?: string;
}

function assertNonce(nonce: string): string {
  if (!NONCE_RE.test(nonce)) throw new Error("invalid CSP nonce");
  return nonce;
}

function publicScriptSrc(input: PublicPolicyInput): string {
  return [
    "script-src 'self'",
    `'nonce-${assertNonce(input.nonce)}'`,
    ...cspHostSources(input.hosts),
    ...(input.dev ? ["'unsafe-eval'"] : []),
  ].join(" ");
}

/** 公開頁 enforce 的那一份:只有會執行程式的指令。 */
export function enforcedPublicPolicy(input: PublicPolicyInput): string {
  return [
    publicScriptSrc(input),
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    `report-uri ${CSP_REPORT_URI}`,
  ].join("; ");
}

/**
 * 完整的 Report-Only policy。不帶 input = 後台 / API 用的那一份(與 1.50.0 之前
 * next.config.ts 送的一字不差);帶 input = 公開頁,script-src 換成 nonce 版本,
 * 核准過的主機加進各個讀取類指令。
 */
export function reportOnlyPolicy(input?: PublicPolicyInput): string {
  const hosts = input ? cspHostSources(input.hosts) : [];
  const extra = (list: readonly string[]) => (list.length > 0 ? ` ${list.join(" ")}` : "");
  const errorOrigin = cspOrigin(input?.errorDsn);
  const connect = [...hosts, ...(errorOrigin ? [errorOrigin] : []), ...(input?.dev ? ["ws:"] : [])];
  return [
    "default-src 'self'",
    // 後台:'unsafe-inline' 是現實(Next 的 inline script 沒有 nonce),留著當作「這裡
    // 還沒收乾淨」的紀錄。'wasm-unsafe-eval' 是後台助理 JS 沙盒(QuickJS,執行期從
    // bytes 編譯 wasm)的必要條件;它只放行 WebAssembly 編譯,不放行 eval。
    input ? publicScriptSrc(input) : "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    // Google Fonts:後台風格選了非預設字體才會載入(lib/admin-theme.ts 的 ADMIN_FONTS)。
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com${extra(hosts)}`,
    // R2 走同源的 /api/files;data: 給 icon/inline SVG;blob: 給上傳預覽。
    `img-src 'self' data: blob:${extra(hosts)}`,
    `font-src 'self' https://fonts.gstatic.com${extra(hosts)}`,
    // extension 的 webhook 是伺服器端送出的,不需要在這裡開。
    `connect-src 'self'${extra(connect)}`,
    // 公開頁:核准過的主機,加上 Google 地圖的嵌入(店家頁尾常見;www.google.com/maps/embed)。
    // 後台那一份不變。只在 Report-Only 這份 —— enforce 的那份本來就不管框架。
    ...(input ? [`frame-src 'self'${extra([...hosts, "https://www.google.com"])}`] : []),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
    // 沒有這一行的 Report-Only 等於沒開:違規只會出現在打開 devtools 的那個人的
    // console。用 report-uri 而不是 report-to:後者要另送 Reporting-Endpoints 標頭,
    // 值必須是絕對網址,而建置期的 next.config 不知道每個站的 origin。
    `report-uri ${CSP_REPORT_URI}`,
  ].join("; ");
}

// 已知的檔案副檔名(robots.txt、sitemap.xml、icon.svg、manifest.webmanifest、public/
// 底下的圖片字體等)。只認這張表,不是「最後一段有點就算檔案」:內容頁的網址可以帶點
// (/blog/v1.2-release),把它當成檔案就等於那一頁沒有 CSP。反過來,一個沒列到的檔案
// 被當成頁面,代價只是多一個它用不到的標頭。
const FILE_EXTENSION_RE =
  /\.(?:txt|xml|json|webmanifest|ico|png|jpe?g|gif|webp|avif|svg|bmp|js|mjs|css|map|woff2?|ttf|otf|eot|pdf|mp4|webm|mp3|ogg|wav|zip|csv|rss|atom|wasm)$/i;

/**
 * 這個路徑是不是公開頁(middleware 要替它產生 nonce、送 enforce 的 policy)。
 * 後台、登入、首次設定、API、Next 的靜態檔不是;最後一段是已知副檔名的檔案也不是。
 */
export function isPublicPagePath(pathname: string): boolean {
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return false;
  if (pathname === "/login" || pathname === "/setup") return false;
  if (pathname.startsWith("/api/") || pathname.startsWith("/_next/")) return false;
  return !isFilePath(pathname);
}

/** 最後一段是已知副檔名的檔案(這些由 middleware 補上後台那份 Report-Only)。 */
export function isFilePath(pathname: string): boolean {
  return FILE_EXTENSION_RE.test(pathname.slice(pathname.lastIndexOf("/") + 1));
}

/**
 * 仍然只送 Report-Only 的路徑(next.config.ts 的 headers() 用)。公開頁的 CSP 標頭
 * 由 middleware 送 —— 兩邊不能對同一個路徑送同一個標頭:OpenNext 合併時 next.config
 * 的標頭蓋過 middleware 的,`next dev` 則相反,同一份設定在兩個環境會送出不同的
 * policy。這張表以外、又不是公開頁的路徑(isFilePath 的檔案)由 middleware 送
 * reportOnlyPolicy(),所以每一個路徑至少有 Report-Only。
 */
export const REPORT_ONLY_PATHS = [
  "/admin",
  "/admin/:path*",
  "/login",
  "/setup",
  "/api/:path*",
  "/_next/:path*",
] as const;
