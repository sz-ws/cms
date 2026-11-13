import type { ReactNode } from "react";
import { FramedPublicPage } from "@/components/PublicFrame";

// [core] 不要在客戶站改這個檔。
//
// 公開站的外框(公告、頁首、頁尾、浮層)。外框放在 layout 裡,在公開頁之間換頁時不會重新掛載。
// 樣子由插槽決定(components/PublicFrame.tsx、core-slots.ts 的 PublicFrame),不改這個檔:
//
//   - 只要加頁首頁尾:extension 註冊 filter:publicHeader / filter:publicFooter;
//     浮層用 filter:publicWidgets(一定要 append:`(w) => [...w, MyWidget]`)。
//   - 整個外框自己畫:站台層插件 fill(PublicFrame, { replace: MyFrame }),MyFrame({ notice, children })。
//     layout 不知道網址;要照網址換樣子的,在 client 元件裡用 usePathname()(src/ext/META.md
//     「A site supplies its own public pages」)。
//
// 這裡渲染的東西會跟著每一頁一起存起來,所以不能讀 cookies()、headers();也不設路由設定
// (dynamic、revalidate 只寫在頁面上;寫在這裡會蓋過或混進頁面的)。

export default function PublicLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <FramedPublicPage>{children}</FramedPublicPage>;
}
