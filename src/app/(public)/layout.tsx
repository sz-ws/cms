import type { ComponentType, ReactNode } from "react";
import { getExtRuntime } from "@/ext/loader";
import { normalizePublicWidgets } from "@/ext/public-widgets";

export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────────────────────────────────────
// [site-seam] 這裡是給站台外框用的接縫 —— 優先用 filter 提供,不得已才改這個檔。
//
// 公開站的外框(header / nav / footer 等每個站台各自不同的東西)。
//
// 這個檔案存在的理由:在它出現之前,一個用這套 CMS 架起來的站要放自己的頁首頁尾,
// 只能去改 src/ 底下的 core 檔案 —— 而那正是讓「日後把 core 的修正 merge 回客戶站」
// 變成解衝突地獄的原因。有了這一層,站台外框有了自己的家。
//
// 【放什麼在這裡】
// 兩種做法,優先選第一種:
//
//   1)【建議】用 extension 提供,不要改這個檔。
//      在你的 extension 裡註冊 filter,回傳一個 React component:
//
//        hooks.addFilter("filter:publicHeader", () => MyHeader);
//        hooks.addFilter("filter:publicFooter", () => MyFooter);
//
//      這樣 core 與客戶站的分歧維持在零,`git merge upstream/main` 永遠不會衝突。
//      同一套機制首頁已經在用了(filter:publicHome,見 ./page.tsx)。
//
//      不佔版位的浮層(購買通知、cookie 橫幅、回到頂端)走另一個插槽,值是陣列:
//
//        hooks.addFilter("filter:publicWidgets", (w) => [...w, MyWidget]);
//
//      一定要 append(`[...w, X]`)不要整包換掉,否則會把別的 extension 的浮層吃掉。
//
//   2)【退而求其次】真的需要這個站獨有、又不值得包成 extension 的東西,才直接改
//      下面的 JSX。改了就要有心理準備:core 之後動到這個檔時要手動合併。
//
// 【不要放什麼】
//   - `<html>` / `<body>` / 字體 / 全域 CSS —— 那些在 src/app/layout.tsx(root)。
//   - 站名、描述、favicon 之類的 metadata —— 走 settings(core.siteTitle 等),
//     root layout 的 generateMetadata() 已經在讀。
//   - 後台的東西 —— 那在 src/app/(admin)/。這裡只包公開路由。
// ─────────────────────────────────────────────────────────────────────────────

export default async function PublicLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const rt = await getExtRuntime();

  // 兩個 filter 都預設 null = 不渲染。沒有任何 extension 註冊時,公開站就是
  // 「只有內容、沒有外框」—— 對還沒設計過頁首頁尾的新站來說是正確的預設。
  //
  // publicWidgets(1.24.0)是浮層插槽,預設空陣列。與上面兩個不同的是它**累加**:
  // extension 約定寫 `(w) => [...w, MyWidget]`,所以多個浮層可以共存,且不受
  // 安裝順序影響。core 不替它們加任何容器 —— 每個 widget 自己決定角落與 z-index。
  const [header, footer, widgets] = await Promise.all([
    rt.hooks.applyFilters<ComponentType | null>("filter:publicHeader", null),
    rt.hooks.applyFilters<ComponentType | null>("filter:publicFooter", null),
    rt.hooks.applyFilters<unknown>("filter:publicWidgets", []),
  ]);

  const Header = header;
  const Footer = footer;
  // 回傳值來自別人寫的 handler,不保證是陣列 —— 收斂理由見 ext/public-widgets.ts。
  const Widgets = normalizePublicWidgets(widgets);

  return (
    <div className="flex min-h-screen flex-col">
      {Header && <Header />}
      <div className="flex-1">{children}</div>
      {Footer && <Footer />}
      {Widgets.map((W, i) => (
        <W key={i} />
      ))}
    </div>
  );
}
