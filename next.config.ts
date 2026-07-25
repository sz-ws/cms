import type { NextConfig } from "next";
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
// 怎麼升級成 enforce:部署後從瀏覽器 console 收集 CSP 違規報告,把真正需要的
// 來源加進來,確認乾淨後把下面這行的 key 改成 "Content-Security-Policy" 即可。
const CSP_REPORT_ONLY = {
  key: "Content-Security-Policy-Report-Only",
  value: [
    "default-src 'self'",
    // 'unsafe-inline' 是目前的現實(見上方說明),留在 Report-Only 裡當作
    // 「我們知道這裡還沒收乾淨」的紀錄,而不是假裝已經安全。
    "script-src 'self' 'unsafe-inline'",
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
  ].join("; "),
};

const nextConfig: NextConfig = {
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
export default nextConfig;

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
