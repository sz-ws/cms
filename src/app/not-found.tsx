import Link from "next/link";

// 全站 404。設計紅線(~/.claude/CLAUDE.md):白底、單一焦點、無漸層背景、無
// pulse/ping 動畫、無裝飾堆疊——大字「404」+ 一行說明 + 回首頁連結,僅此而已。
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-white px-6 text-center">
      <p className="text-7xl font-semibold tracking-tight text-gray-900">404</p>
      <p className="text-base text-gray-600">找不到這個頁面。</p>
      <Link
        href="/"
        className="text-sm font-medium text-gray-900 underline underline-offset-4"
      >
        回首頁
      </Link>
    </main>
  );
}
