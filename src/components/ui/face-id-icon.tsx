// Face ID 語彙的 passkey icon:rounded 掃描框四角 + 笑臉。stroke 走 currentColor,
// 跟著呼叫端文字色;比 emoji 穩定(不受平台字型影響)也符合系統感。
// 抽自 LoginForm(登入頁的 passkey 按鈕);/admin/account 的 PasskeysManager 也要用同一
// 個符號(列表小圖示、空狀態大圖示),故獨立成 vendored ui 元件避免兩處各自維護一份 SVG。
export function FaceIdIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d="M8 3H6a3 3 0 0 0-3 3v2" />
      <path d="M16 3h2a3 3 0 0 1 3 3v2" />
      <path d="M21 16v2a3 3 0 0 1-3 3h-2" />
      <path d="M8 21H6a3 3 0 0 1-3-3v-2" />
      <path d="M9 9.4v1.4" />
      <path d="M15 9.4v1.4" />
      <path d="M9 14.8c.85.8 1.85 1.2 3 1.2s2.15-.4 3-1.2" />
    </svg>
  );
}
