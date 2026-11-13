import { NotFoundMessage } from "@/components/NotFoundMessage";
import { Slot } from "@/components/Slot";
import { PublicNotFound } from "@/ext/core-slots";

// 公開頁的 404:沒有 route 接的網址、壞掉的 `%` 序列,以及 route 自己 notFound() 的(例如站台接住一個
// 網址來讓它打不開)。2.x 起畫在 (public)/layout.tsx 的外框裡(以前用根的 not-found,不在外框裡);
// 內容是畫面的插槽 PublicNotFound(預設是核心的 404 內容)。跟頁面一起存起來,所以同樣不讀請求。

export default function PublicNotFoundPage() {
  return (
    <Slot of={PublicNotFound} props={{}}>
      <NotFoundMessage />
    </Slot>
  );
}
