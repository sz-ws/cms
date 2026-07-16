// 單一固定的接線點。**永遠**從 "./verify.local" 匯入 —— 這個路徑在 git 歷史
// 裡不存在(gitignored),但 predev/prebuild 會在 build 前保證它存在於磁碟上
// (見 package.json 的 predev/prebuild + scripts/ensure-licensing-stub.mjs)。
//
// 為什麼不能用 dynamic import + try/catch 做「檔案不存在就優雅降級」:
// Cloudflare Workers 部署完全沒有 runtime 檔案系統,webpack/Turbopack 必須在
// build 當下（不是執行期)就解析出這裡的 import 指向哪個實體檔案並打包進去
// ——靜態 import specifier 若在 build 當下找不到對應檔案,build 直接失敗,
// try/catch 完全幫不上忙(那是執行期語意,這裡是編譯期問題)。這也是為什麼
// 選擇「build 前自動生成 stub,保證檔案永遠存在」而不是單純 .gitignore
// 加一個「有就用、沒有就跳過」的判斷。
export type { LicenseCheckResult, LicenseVerifier } from "./types";
export { verifier } from "./verify.local";
