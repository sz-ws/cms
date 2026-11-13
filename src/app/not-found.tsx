import { NotFoundMessage } from "@/components/NotFoundMessage";

// 全站 404(公開頁以外的網址)。內容在 components/NotFoundMessage.tsx,公開頁的 404((public)/not-found.tsx)預設也是它。
export default function NotFound() {
  return <NotFoundMessage />;
}
