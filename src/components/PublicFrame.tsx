import type { ComponentType, ReactNode } from "react";
import { SiteNoticeBar } from "@/app/(public)/site-notice";
import { PublicFrame } from "@/ext/core-slots";
import { normalizePublicWidgets } from "@/ext/public-widgets";
import type { SiteNoticeWindow } from "@/lib/site-notice";
import { getSiteNoticeWindow } from "@/lib/site-notice-server";
import { Slot } from "./Slot";

// 公開頁的外框(插槽 PublicFrame,core-slots.ts)。(public)/layout.tsx 用它:外框在 layout 裡,換頁時
// 不會重新掛載(頁首、跑馬燈、播放中的聲音照常),這是 Next 的標準做法。layout 不知道網址,所以外框拿到的只有
// 公告與這一頁;要照網址換樣子(首頁不加框、內頁加頁首…)的外框在 client 元件裡用 usePathname() 決定
// (client 元件照樣在伺服器上畫,存起來的 HTML 已經是那個網址的樣子;src/ext/META.md 有範例)。
//
// 站台自己另開、不存起來的路由檔(放在自己的 route group,例如要讀登入狀態的頁),在那個 group 的 layout 裡
// 用同一個元件,才跟其他公開頁長得一樣:
//
//   export default function SiteLayout({ children }: { children: ReactNode }) {
//     return <FramedPublicPage>{children}</FramedPublicPage>;
//   }
//
// (兩個 route group 之間換頁時,外框屬於不同的 layout,會重新掛載。)
//
// 沒有人換掉外框時,畫出來的跟 1.x 起的 (public)/layout.tsx 一字不差(公告列、頁首、內容、頁尾、浮層)。
// 換掉的話,filter:publicWidgets 的浮層畫在外框後面(浮層各自決定角落)。

interface DefaultFrameProps {
  notice: SiteNoticeWindow | null;
  Header: ComponentType | null;
  Footer: ComponentType | null;
  Widgets: ComponentType[];
  children: ReactNode;
}

function DefaultPublicFrame({ notice, Header, Footer, Widgets, children }: DefaultFrameProps) {
  return (
    <div className="flex min-h-screen flex-col">
      {notice && <SiteNoticeBar notice={notice} />}
      {Header && <Header />}
      <div className="flex-1">{children}</div>
      {Footer && <Footer />}
      {Widgets.map((W, i) => (
        <W key={i} />
      ))}
    </div>
  );
}

/** 公開頁的外框包住 children(公開頁的 layout,或站台自己的 route group 的 layout)。 */
export async function FramedPublicPage({ children }: { children: ReactNode }): Promise<ReactNode> {
  const { getExtRuntime } = await import("@/ext/loader");
  const rt = await getExtRuntime();
  // 三個 filter 預設 null / 空陣列 = 不畫;公告沒開是 null。
  const [header, footer, widgets, notice] = await Promise.all([
    rt.hooks.applyFilters<ComponentType | null>("filter:publicHeader", null),
    rt.hooks.applyFilters<ComponentType | null>("filter:publicFooter", null),
    rt.hooks.applyFilters<unknown>("filter:publicWidgets", []),
    getSiteNoticeWindow(),
  ]);
  // 回傳值來自別人寫的 handler,不保證是陣列 —— 收斂理由見 ext/public-widgets.ts。
  const Widgets = normalizePublicWidgets(widgets);
  const replaced = rt.slots.view(PublicFrame).replace !== null;
  const fallback = (
    <DefaultPublicFrame notice={notice} Header={header} Footer={footer} Widgets={replaced ? [] : Widgets}>
      {children}
    </DefaultPublicFrame>
  );
  return (
    <>
      <Slot of={PublicFrame} props={{ notice, children }}>
        {fallback}
      </Slot>
      {replaced && Widgets.map((W, i) => <W key={i} />)}
    </>
  );
}
