import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { REPORT_ONLY_PATHS, reportOnlyPolicy } from "./src/lib/csp";

const projectRoot = dirname(fileURLToPath(import.meta.url));

// ── Security headers ──────────────────────────────────────────────────────
// 這一段的價值在於它是**上游**:每一個從這個 scaffold 長出來的站都自動拿到,
// 而下游幾乎不會自己補。所以寧可放在這裡,也不要寫成「部署後記得設定」。
//
// 分兩級:下面這組是無風險的,一律 enforce。CSP 因為會真的擋掉東西,公開頁只 enforce
// 執行程式的那幾條、其餘仍是 Report-Only(見下方 CSP_REPORT_ONLY 的註解)。
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

// CSP(1.50.0 起分兩種頁面,組法與理由都在 src/lib/csp.ts):
//
//   - 公開頁:middleware 逐請求產生 nonce,送 enforce 的 Content-Security-Policy
//     (只管執行程式的指令:script-src 帶 nonce 與核准過的宣告式 script 主機)與完整的
//     Report-Only。這裡**不能**再對公開頁送 CSP 標頭 —— OpenNext 合併標頭時
//     next.config 的蓋過 middleware 的,`next dev` 則相反,同一份設定會在兩個環境
//     送出不同的 policy。
//   - 後台、登入、首次設定、/api、Next 靜態檔:維持 Report-Only,由這裡送(路徑見
//     REPORT_ONLY_PATHS)。後台有 QuickJS 沙盒('wasm-unsafe-eval')、後台字體與大量
//     inline style;要 enforce,先看 /api/csp-report 的收件確認乾淨。
//
// ⚠️ 後台 enforce 前還剩一件要**實測**的:worker-src。沙盒的 Worker 走 `new URL(...)`
// 同源打包產物,理論上吃 default-src 'self' 的 fallback,但要在 Report-Only 的
// 收件裡確認真的沒有 worker-src 違規,而不是推論。
//
// 相對路徑 import:next.config.ts 由 Node 在建置期載入,不經過 bundler 的 `@/` alias;
// src/lib/csp.ts 零依賴,正是為了讓這裡能直接載入。
const CSP_REPORT_ONLY = {
  key: "Content-Security-Policy-Report-Only",
  value: reportOnlyPolicy(),
};

const nextConfig: NextConfig = {
  // `X-Powered-By: Next.js` 對使用者零價值,對掃描器是免費的指紋(框架 + 大版號 →
  // 直接對照已知漏洞清單)。關掉它不影響任何功能。
  poweredByHeader: false,
  // 瀏覽器端的頁面快取:30 秒內切回同一頁直接用上次的畫面,不打伺服器、不出轉圈。
  // 預設是 0 —— 整站 force-dynamic,每次換頁都重算一次 layout。
  //
  // 不會看到自己剛改的舊資料:存檔後會 router.refresh(),它清掉整個頁面快取
  // (Next 16 的 refresh-reducer 呼叫 invalidateBfCache)。別人改的東西最多晚 30 秒
  // 才在「切回來」時出現;插件頁的資料是自己 fetch 的,不受這裡影響
  // (lib/client-cache.ts 先顯示上次的,再重抓)。
  experimental: {
    staleTimes: { dynamic: 30 },
  },
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
      { source: "/:path*", headers: SECURITY_HEADERS },
      ...REPORT_ONLY_PATHS.map((source) => ({ source, headers: [CSP_REPORT_ONLY] })),
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
  // 關掉三種自動包裝(server component / route handler / middleware)。
  //
  // 包裝 loader 會在**每一個** page、layout、route.ts 與 middleware 的最上面靜態
  // import `@sentry/nextjs` —— 於是不管有沒有設 DSN,每個 isolate 的第一個 request
  // 都要先把整包 SDK(server bundle 裡最大的一塊,約 1.6MB,含 OpenTelemetry)載入並
  // 執行一次,冷啟動有一大段時間花在這裡。
  //
  // 包裝換到的東西在這個專案裡是零:tracesSampleRate 是 0(見 sentry-options.ts),
  // 剩下的唯一功能是「丟到框架邊界的例外」—— 那正是 src/instrumentation.ts 的
  // onRequestError 在接的,而且它會先綁好後台設定的 DSN,包裝不會。
  webpack: {
    autoInstrumentServerFunctions: false,
    autoInstrumentMiddleware: false,
    autoInstrumentAppDirectory: false,
  },
  // instrumentation-client.ts 刻意不匯出 onRouterTransitionStart(tracesSampleRate 是 0,
  // 它什麼都不做,匯出它就得在每一頁的進入點靜態載入 SDK)。少了它 plugin 每次建置都印
  // 一行「ACTION REQUIRED」,而那行字會讓人以為有東西壞了。
  suppressOnRouterTransitionStartWarning: true,
});

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
