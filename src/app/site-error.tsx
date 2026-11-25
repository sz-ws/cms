// ─────────────────────────────────────────────────────────────────────────────
// [site] 這個檔預期逐站不同 —— 這裡是你的,改它不會跟上游衝突。
//
// 整個網站畫不出來時(src/app/global-error.tsx)顯示的畫面。global-error.tsx 是 core 的:它判斷要不要
// 自動重新整理一次,畫面交給這裡。站台要自己的樣子(logo、品牌色、字型)就改這個檔。
//
// 兩種狀態:
//   - reloading:部署之後,瀏覽器手上的舊頁面要不到已經不在的 chunk,global-error 正在自動重新整理一次。
//     這個畫面只會閃一下,像頁面正常載入,不要寫成錯誤。
//   - 其他:真的壞了(或自動重新整理過一次還是不行)。一句話加兩個出口:重新整理、回首頁。
//
// 這個畫面取代整份 <html>(根 layout 不在了),所以:
//   - 預設版只用 inline style。要 import 自己的 CSS 也可以,但部署之後舊頁面那份 CSS 可能也要不到;
//     至少讓背景色與字在沒有 CSS 時也看得懂。
//   - 回首頁用一般的 <a>(整頁載入),不用 next/link:這時候 client 端的路由不一定還能用。
//   - <html lang> 由 SITE_ERROR_LANG 決定(跟這裡的文字同一種語言),根 layout 讀的站台語系這時讀不到。
//
// 預設跟核心的 404(components/NotFoundMessage.tsx)同一個樣子:白底、一句話、出口。
// ─────────────────────────────────────────────────────────────────────────────
/* eslint-disable @next/next/no-html-link-for-pages -- 刻意整頁載入,見檔頭。 */

export type SiteErrorProps = {
  /** global-error 正在自動重新整理(頁面的程式碼要不到,多半是剛部署過)。 */
  reloading: boolean;
  /** 整頁重新整理。 */
  reload: () => void;
};

/** 這個畫面的語言,給 global-error 的 <html lang>。 */
export const SITE_ERROR_LANG = "zh-Hant";

const page = {
  display: "flex",
  minHeight: "100vh",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 16,
  margin: 0,
  padding: "0 24px",
  background: "#fff",
  color: "#111827",
  textAlign: "center",
  fontFamily: 'system-ui, -apple-system, "PingFang TC", "Noto Sans TC", sans-serif',
} as const;

const actions = { display: "flex", gap: 16, alignItems: "center" } as const;
const button = {
  padding: "8px 16px",
  border: 0,
  borderRadius: 6,
  background: "#111827",
  color: "#fff",
  font: "inherit",
  fontSize: 14,
  cursor: "pointer",
} as const;
const link = { color: "#111827", fontSize: 14, textUnderlineOffset: 4 } as const;

export function SiteError({ reloading, reload }: SiteErrorProps) {
  if (reloading) {
    return (
      <main style={page}>
        <p role="status" style={{ margin: 0, fontSize: 16, color: "#4b5563" }}>
          重新載入中
        </p>
      </main>
    );
  }
  return (
    <main style={page}>
      <h1 style={{ margin: 0, fontSize: 18, fontWeight: 500 }}>這個頁面沒有載入成功。</h1>
      <div style={actions}>
        <button type="button" onClick={reload} style={button}>
          重新整理
        </button>
        <a href="/" style={link}>
          回首頁
        </a>
      </div>
    </main>
  );
}
