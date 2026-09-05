import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));

// ── Security headers ──────────────────────────────────────────────────────
// 這一段的價值在於它是**上游**:每一個從這個 scaffold 長出來的站都自動拿到,
// 而下游幾乎不會自己補。所以寧可放在這裡,也不要寫成「部署後記得設定」。
//
// 分兩級:下面這組是無風險的,一律 enforce。CSP 因為會真的擋掉東西,只送
// Report-Only(理由與升級方式見下方 CSP_REPORT_ONLY 的註解)。
const SECURITY_HEADERS = [
  // MIME sniffing:瀏覽器不得無視 Content-Type 自行猜測。
  { key: "X-Content-Type-Options", value: "nosniff" },
  // 點擊劫持。這個 app 沒有任何 iframe 用途(已確認),所以直接全禁。
  // frame-ancestors 是現代作法,X-Frame-Options 給舊瀏覽器兜底。
  { key: "X-Frame-Options", value: "DENY" },
  // Referrer:跨站只送 origin,同站送完整路徑。admin 的路徑會洩漏內容 id,
  // 預設的 strict-origin-when-cross-origin 已經夠,但明寫避免受瀏覽器預設值變動影響。
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // HSTS。Cloudflare 前面已經強制 https,這條是給直連與預載清單用的。
  // 不加 preload —— 那是不可逆的,應該由站台擁有者自己決定。
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  // 切斷跨來源開啟者關係(XS-Leaks / tabnabbing)。這個 app 目前**沒有任何 popup
  // 流程**:OIDC 走整頁 redirect(/api/auth/oauth/[provider]/start),passkey 是
  // WebAuthn 不開視窗,全 repo 零 `window.open`。所以取最嚴的 same-origin。
  //
  // ⚠️ 下游若裝了走 **popup OAuth** 的 extension,popup 會拿不到 opener、
  // postMessage 回不來(而且是靜默的)。那種情況把值改成
  // `same-origin-allow-popups` —— 仍擋得住「被別人開啟」,只放行自己開的視窗。
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // 關掉這個 app 完全用不到的強權能力。
  //
  // ⚠️ publickey-credentials-get / -create 必須明確保留 self ——
  // 這兩個是 WebAuthn(passkey 登入)的權能,一旦被空清單關掉,
  // 整個 passkey 流程會靜默失效。這是寫 Permissions-Policy 最常見的自殘。
  {
    key: "Permissions-Policy",
    value: [
      "accelerometer=()",
      "camera=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "payment=()",
      "usb=()",
      "interest-cohort=()",
      "publickey-credentials-get=(self)",
      "publickey-credentials-create=(self)",
    ].join(", "),
  },
];

// CSP 只送 Report-Only,**刻意不 enforce**。
//
// 為什麼不直接開:這個 app 有兩個真實的 inline 來源 ——
//   1. declarative extension 的 `theme` design tokens 會 render 成 inline style
//      (src/ext/dx/theme-scope.tsx),以及泛用 view 裡大量的 style={{...}}
//   2. Next.js 自己會注入 inline script 做 hydration/route announcer
// 要真正收緊需要 nonce 化,那是一個獨立的工程(且 OpenNext 下要驗證 nonce
// 能不能穿過 edge render)。在那之前開 enforce 只會讓站台白畫面。
//
// 怎麼升級成 enforce:讓站台跑一陣子,收 /api/csp-report 進來的違規(見下方
// report-uri),把真正需要的來源加進來,確認乾淨後把下面這行的 key 改成
// "Content-Security-Policy" 即可。
//
// `'wasm-unsafe-eval'` 已經在 script-src 裡(2026-09-02;理由見該行)—— 後台助理的
// JS 沙盒(QuickJS)是執行期從 bytes 編譯 wasm 的,少了它一 enforce 沙盒就死。
// ⚠️ enforce 前還剩一件要**實測**的:worker-src。沙盒的 Worker 走 `new URL(...)`
// 同源打包產物,理論上吃 default-src 'self' 的 fallback,但要在 Report-Only 的
// 收件裡確認真的沒有 worker-src 違規,而不是推論。
const CSP_REPORT_ONLY = {
  key: "Content-Security-Policy-Report-Only",
  value: [
    "default-src 'self'",
    // 'unsafe-inline' 是目前的現實(見上方說明),留在 Report-Only 裡當作
    // 「我們知道這裡還沒收乾淨」的紀錄,而不是假裝已經安全。
    //
    // 'wasm-unsafe-eval' 是**必要的**,不是妥協:後台助理的 JS 沙盒(QuickJS,
    // src/components/admin/agent/code-sandbox.worker.ts)在執行期從 bytes 編譯
    // wasm,沒有這一項的 policy 一 enforce 沙盒就死。先放進 Report-Only,收件端
    // 才不會被每一次沙盒啟動的 wasm-eval 違規灌滿,真正要看的違規才浮得上來。
    // (它只放行 WebAssembly 編譯,不放行 JS 的 eval / new Function。)
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    // R2 走同源的 /api/files;data: 給 icon/inline SVG;blob: 給上傳預覽。
    "img-src 'self' data: blob:",
    "font-src 'self'",
    // extension 的 webhook 是伺服器端送出的,不需要在這裡開。
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
    // 沒有這一行的 Report-Only 等於沒有開:違規只會出現在**打開 devtools 的那個人**
    // 的 console 裡,而升級成 enforce 的前提正是「先確定真實流量上沒有東西會被擋」。
    // 端點見 src/app/api/csp-report/route.ts(公開、限流、不落庫,轉給錯誤回報層)。
    //
    // 用 report-uri 而不是新的 report-to:report-to 需要另外送 `Reporting-Endpoints`
    // 標頭,而那個標頭的值必須是**絕對網址** —— next.config 是建置期產物,這裡不
    // 可能知道每個下游站的 origin。report-uri 雖然標為 deprecated,但相對路徑可用,
    // 且 Chrome/Firefox/Safari 現行版本都還照送。
    "report-uri /api/csp-report",
  ].join("; "),
};

const nextConfig: NextConfig = {
  // `X-Powered-By: Next.js` 對使用者零價值,對掃描器是免費的指紋(框架 + 大版號 →
  // 直接對照已知漏洞清單)。關掉它不影響任何功能。
  poweredByHeader: false,
  // Local tunnel used to reach this dev server from another device/browser.
  // Keep this exact rather than allowing every *.okuso.uk subdomain.
  allowedDevOrigins: ["3001.okuso.uk"],
  // workers-og 以 `import x from "./x.wasm"` 靜態載入 yoga / resvg。那是
  // **Cloudflare 的慣例** —— 該 import 會拿到一個 WebAssembly.Module。
  //
  // webpack 產不出那個形狀:開了 asyncWebAssembly 之後它會把 .wasm 當成一個
  // 有「具名 exports」的模組,於是報 "does not contain a default export"。
  // 所以正解不是叫 webpack 去處理它,而是**叫 webpack 別碰** —— 把整個套件
  // 標成 server external,讓那個 import 原封不動留到 Worker 打包階段
  // (@opennextjs/cloudflare → wrangler),那一層原生支援 wasm 模組 import。
  //
  // 為什麼不能改用 Turbopack 繞過:Turbopack 的產出沒有
  // .next/server/instrumentation.js,而 @opennextjs/aws 的 copyTracedFiles 一定
  // 會去找它 —— 見 package.json 的 `build` script 釘死 --webpack 的理由。
  serverExternalPackages: ["workers-og"],
  // Sentry 的 server entry(`@sentry/nextjs` 的 index.server)會**急切地** require 一整條
  // 只在 `next build` 期間才用得到的 withSentryConfig 鏈;10.73 起那條鏈多拉進了
  // `@sentry/server-utils/orchestrion/webpack`,而它內嵌了一份 es-module-lexer ——
  // 那份 lexer 在**模組頂層**就跑 `WebAssembly.compile()`。workerd 不准執行期編譯 wasm,
  // 於是每一個新 isolate 都噴一次 `CompileError: Wasm code generation disallowed by
  // embedder`(unhandled rejection;請求本身照樣 200)—— 一個純噪音的假錯誤,而它會把
  // 錯誤回報端灌滿,真正該看的例外反而浮不上來。
  //
  // 那份 lexer 在執行期從來不會被呼叫(它存在的理由是讓 webpack plugin 在 `next build`
  // 時解析原始碼),所以正解是把它從 **server bundle** 剪掉,而不是 patch 或降版。
  //
  // 壞掉的方式是良性的:Sentry 哪天改了這個子路徑,alias 就只是靜默地不再命中 ——
  // 結果是那行噪音回來,不會讓建置或執行期壞掉。
  //
  // ⚠️ `next.config.ts` 這個檔案本身是 **Node 載入**的,不經過 webpack,所以下面
  // `withSentryConfig(...)` 在建置期該做的事完全不受影響;被剪掉的只有「打包進 Worker
  // 的那一份」。
  //
  // ⚠️ 這條只對 webpack 生效(見 package.json 的 `build` 釘死 `--webpack` 的理由)。
  // 哪天真的換到 Turbopack,要在上面的 `turbopack` 裡補一條對應的 `resolveAlias`。
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        "@sentry/server-utils/orchestrion/webpack": false,
      };
    }
    return config;
  },
  turbopack: {
    root: projectRoot,
  },
  async headers() {
    return [
      { source: "/:path*", headers: [...SECURITY_HEADERS, CSP_REPORT_ONLY] },
    ];
  },
  // Optional isolated build dir so a second dev server can run alongside the
  // primary one without contending for the same `.next/dev` lock. Activated
  // only when CMS_DEV_DISTDIR is set; no effect on normal dev/build/deploy.
  ...(process.env.CMS_DEV_DISTDIR
    ? { distDir: process.env.CMS_DEV_DISTDIR }
    : {}),
};
// ── 錯誤回報(GlitchTip / Sentry 協定)─────────────────────────────────────
// withSentryConfig 在這裡只做兩件事:把 instrumentation-client.ts 排進前端 bundle,
// 以及在建置期把 SDK 的一些 no-op 分支剪掉。它**不需要**任何 DSN 或帳號 —— 站台
// 沒設 DSN 時整套就是安靜關閉(見 src/lib/observe/sentry-options.ts)。
//
// 兩個明確關掉的東西:
//
//   telemetry —— 建置時回報用量給 Sentry 公司。這個 repo 是給人 fork 的公開範本,
//     替每一個下游站台決定「要不要把建置資訊送給第三方」不是我們的權利。而且終點
//     本來就是自架的 GlitchTip,送過去也沒有對象。
//
//   sourcemaps —— 上傳 source map 需要 auth token 與 org/project,而 GlitchTip 對
//     source map 的處理和 Sentry SaaS 不一樣。更重要的是:上傳等於把整個後台的原始碼
//     交給收集端。堆疊裡看得到檔名與行號已經夠查問題了。
//
// ⚠️ 刻意**不加** `disableLogger` —— 它在 Turbopack 下不支援,加了只會在每次
// `next build` 噴一行 deprecation 警告,而那行警告會被當成「有東西壞了」。
export default withSentryConfig(nextConfig, {
  telemetry: false,
  sourcemaps: { disable: true },
  // 建置後不去 Sentry 的 API 建 release。我們沒有 auth token,也沒有要跟任何 SaaS
  // API 說話。
  //
  // ⚠️ 每次 `next build` 仍會印一行 `No auth token provided. Will not create
  // release.` —— 那是**預期的**,不是設定漏了。plugin 的檢查順序是先看有沒有偵測到
  // release 名稱、再看有沒有 token,`create: false` 排在那之後才被讀到。
  //
  // 那個「偵測到的 release 名稱」值得留著:plugin 會把它編進 bundle,於是前端事件
  // 自動帶上這次部署的 git sha —— 而「這個錯誤是哪一版弄出來的」是查錯時最先想知道
  // 的事。要讓警告消失只能連那個名稱一起關掉(或整包 silent),兩個都比一行警告貴。
  // runtime 端若另外設了 CMS_ERROR_RELEASE 會覆蓋它(見 sentry-options.ts)。
  release: { create: false },
});

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
