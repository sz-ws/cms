// [core] Content-Security-Policy 的組法。零依賴:next.config.ts(Node 在建置期載入)import 這一份,
// 每一個 CSP 標頭都是 next.config.ts 的 headers() 送出的固定字串。
//
// ## 兩種頁面、兩種待遇(2.0)
//
// 公開頁(以及 robots.txt 這類檔案):整頁存起來給每個訪客(見 (public)/[[...slug]]/page.tsx),
// 送**兩個**固定標頭,OpenNext 快取命中時一樣會送:
//
//   Content-Security-Policy(enforce,publicPolicy):只管會執行程式的東西。
//     script-src 'self' 'unsafe-inline' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
//   Content-Security-Policy-Report-Only(publicReportOnlyPolicy):完整的目標 policy(圖片、字體、
//     連線、表單…),繼續收違規,作為哪天把其餘指令也改成 enforce 的依據。
//
// 為什麼 script-src 是 'unsafe-inline' 而不是逐請求的 nonce:Next.js 的 hydration 與 RSC payload
// 本身就是 inline script;nonce 每個請求都不一樣,放不進存起來給每個人的頁面(Next 的 CSP 指南:
// 用 nonce 就必須逐請求渲染,ISR 會關掉)。核准過的宣告式 script 的主機也不再逐站列出
// (那要逐請求查資料庫),https: 全部放行。還守得住的是不靠 nonce 的那幾條:不准 <object>、
// 不准改 <base>、不准被別人放進框架。
//
// 後台、登入、首次設定、/api、Next 靜態檔:維持 Report-Only(reportOnlyPolicy)。後台有 QuickJS
// 沙盒、後台字體、大量 inline style,還沒有收乾淨的依據。
//
// ## 其餘指令什麼時候改成 enforce(1.56 之後檢查過一次,結論:還不行)
//
// 規則:一個指令要有真實流量的回報、確認裡面只剩該擋的東西,才搬進 enforce。推論不算。
//
// 回報去了哪裡:/api/csp-report **刻意不落庫**(見該檔:公開寫入面),只轉給錯誤回報層
// (lib/observe,要有 DSN)與 console(`wrangler tail` 即時看得到,沒開 Workers Logs 就不留)。
// D1 裡唯一留下的是它的限流計數(login_attempts 的 `csp-report:<ip>`,每個來源只留最近
// 5 分鐘那一窗)。檢查的那個正式站:沒設 DSN,所以沒有任何一筆違規的內容可看;計數顯示
// 10 天內 23 個來源、至少 111 筆,多數來源一次造訪固定 2 筆。也就是說每次造訪都有東西
// 違規,但不知道是哪個指令、哪個來源(2 筆的形狀像是同一個違規被 enforce 與 Report-Only
// 兩份 policy 各報一次,也可能是瀏覽器外掛)。在知道之前改成 enforce 就是賭。
//
// 所以逐項維持 Report-Only,另外各有已知會被擋的正當流量:
//   - form-action 'self':結帳會把表單 POST 到金流閘道(外站)。
//   - img-src:內容裡可能有外站圖片(編輯器貼的網址)。
//   - frame-src:清單只有 Google 地圖;Turnstile 的挑戰(challenges.cloudflare.com)與
//     Firebase 登入(authDomain 的 iframe)都不在上面。
//   - connect-src:Firebase 登入要連 identitytoolkit / securetoken.googleapis.com,不在上面。
//   - style-src / font-src / default-src:宣告式插件的主機以外,沒有任何資料說明還有誰。
//   - upgrade-insecure-requests:不會產生回報,沒有資料可看;瀏覽器對混合內容本來就會
//     自動升級或擋下,改 enforce 幾乎沒有差別,也就沒有理由在沒資料時動它。
// 要拿到資料:設 CMS_ERROR_DSN(或啟用 sentry 插件),或在 wrangler 開 Workers Logs 之後
// 查 `[csp]` 開頭的 log。拿到之後照上面的規則一項一項搬。
//
// 後台、登入、/api 也維持 Report-Only:同樣沒有任何一筆後台的回報可看;而後台要驗的東西比
// 公開頁多 —— code extension 的後台頁、QuickJS 沙盒('wasm-unsafe-eval')、/login 的 Firebase
// 按鈕(它的 SDK 會從 apis.google.com 載入程式)、大量 inline style。證明不了就不動。

/** CSP 違規回報的收件端點(src/app/api/csp-report/route.ts)。 */
export const CSP_REPORT_URI = "/api/csp-report";

/** 完整的 Report-Only policy;script-src 與(公開頁才有的)frame-src 由呼叫端決定。 */
function fullPolicy(scriptSrc: string, frameSrc?: string): string {
  return [
    "default-src 'self'",
    scriptSrc,
    // Google Fonts:後台風格選了非預設字體才會載入(lib/admin-theme.ts 的 ADMIN_FONTS)。
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    // R2 走同源的 /api/files;data: 給 icon/inline SVG;blob: 給上傳預覽。
    "img-src 'self' data: blob:",
    "font-src 'self' https://fonts.gstatic.com",
    // extension 的 webhook 是伺服器端送出的,不需要在這裡開。
    "connect-src 'self'",
    ...(frameSrc ? [frameSrc] : []),
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

/**
 * 後台、登入、/api 的 Report-Only(與 1.50.0 之前 next.config.ts 送的一字不差)。
 * 'unsafe-inline' 是現實(Next 的 inline script),留著當作「這裡還沒收乾淨」的紀錄;
 * 'wasm-unsafe-eval' 是後台助理 JS 沙盒(QuickJS,執行期從 bytes 編譯 wasm)的必要條件,
 * 它只放行 WebAssembly 編譯,不放行 eval。
 */
export function reportOnlyPolicy(): string {
  return fullPolicy("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'");
}

const PUBLIC_SCRIPT_SRC = "script-src 'self' 'unsafe-inline' https:";

/**
 * 公開頁的固定 CSP(enforce):只有會執行程式的指令。dev = `next dev`:React 的開發工具需要 eval。
 */
export function publicPolicy(dev = false): string {
  return [
    `${PUBLIC_SCRIPT_SRC}${dev ? " 'unsafe-eval'" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    `report-uri ${CSP_REPORT_URI}`,
  ].join("; ");
}

/**
 * 公開頁的 Report-Only:後台那一份,script-src 換成公開頁 enforce 的那條,加上 Google 地圖的嵌入
 * (店家頁尾常見;www.google.com/maps/embed)。宣告式 script 的圖片、字體、連線會照實出現在回報裡。
 */
export function publicReportOnlyPolicy(): string {
  return fullPolicy(PUBLIC_SCRIPT_SRC, "frame-src 'self' https://www.google.com");
}

/**
 * next.config.ts headers() 的 source:REPORT_ONLY_PATHS 以外的每一條路徑(公開頁,以及
 * robots.txt 這類檔案 —— 檔案多一個用不到的標頭沒有代價)。寫法是 Next 文件的負向前瞻範例。
 * /oauth/authorize(MCP 的同意畫面)也在這裡,所以拿得到 frame-ancestors 'none'。
 */
export const PUBLIC_PAGES_SOURCE = "/:path((?!admin$|admin/|login$|setup$|api/|_next/).*)";

/**
 * 只送後台那份 Report-Only 的路徑(next.config.ts 的 headers() 用)。其餘每一條路徑走
 * PUBLIC_PAGES_SOURCE。middleware 不送任何 CSP —— 兩邊對同一個路徑送同一個標頭時,OpenNext 與
 * `next dev` 合併的先後相反,同一份設定會在兩個環境送出不同的 policy。
 */
export const REPORT_ONLY_PATHS = [
  "/admin",
  "/admin/:path*",
  "/login",
  "/setup",
  "/api/:path*",
  "/_next/:path*",
] as const;
