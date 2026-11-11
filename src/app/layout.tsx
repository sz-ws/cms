// ─────────────────────────────────────────────────────────────────────────────
// [core] 不要在客戶站改這個檔。
//
// 上游會持續改它,改了之後 `git merge upstream/main` 每次都會在同一處衝突。
// 需要逐站不同的東西各自有家:
//   - 品牌色 / 字體 / 樣式覆寫 → ./site.css
//   - 站名 / 描述               → settings(core.siteTitle、core.siteDescription),
//                                 下面的 generateMetadata() 已經在讀
//   - 公開站的頁首頁尾         → (public)/layout.tsx 的 filter,見該檔說明
//   - favicon                   → 後台「設定」的網站圖示網址(core.siteIcon,下面的
//                                 generateMetadata() 在讀);(admin)/ 底下那份是後台用的產品 icon
// ─────────────────────────────────────────────────────────────────────────────
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
// 站台自訂樣式。**必須排在 globals.css 之後** —— 兩者同為 :root 層級的宣告,
// 後載入者才蓋得掉前者的 token 預設值。site.css 預設是空的。
import "./site.css";
// Self-hosted Chiron Hei HK (昭源黑體) TC fallback face declarations. The css
// lives in public/ (kept out of Tailwind @source scanning) but is imported here
// so Next bundles it; its unicode-range-sliced @font-face set means the browser
// only fetches the woff2 slices a page actually needs. No CJK preload — Latin
// keeps rendering via Geist/Inter.
import "../../public/fonts/chiron-hei-hk/chiron-hei-hk.css";
import { Geist, Inter } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DateTimeProvider } from "@/components/DateTimeProvider";
import { CurrencyProvider } from "@/components/CurrencyProvider";
import { getSiteShell } from "@/lib/site-shell";
import { cn } from "@/lib/utils";

// Distinct var names (not --font-sans/--font-heading) so they don't collide with
// the Tailwind theme tokens of the same name — the theme composes the full stack
// (Latin face → Chiron Hei HK → system) from these in globals.css @theme.
const interHeading = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});
const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });

// 2.0:根 layout 不再 force-dynamic。公開頁由 (public)/[[...slug]]/page.tsx 在第一次造訪時
// 算好整頁存起來(dynamic = "error"),後台、登入、首次設定各自 force-dynamic。這裡讀的站台
// 外殼設定走 getSiteShell():`next build` 會經由這個 layout 預先產生 404 頁,而建置時沒有
// 網站的資料庫,所以那時它回內建預設值;正式環境的每個請求照常讀設定(見 lib/site-shell.ts)。
//
// 這個 layout 會跟著公開頁一起被存起來,所以不能讀 cookies()、headers() 或時鐘。

// 站台標題/描述取自 settings,不硬寫 —— 否則每個用這套架起來的站都會送出
// <title>CMS</title>。讀不到時才退回產品名,那是「還沒設定過」的合理預設而非別人的品牌。
export async function generateMetadata(): Promise<Metadata> {
  const shell = await getSiteShell();
  return {
    title: shell.title,
    description: shell.description,
    // 1.68.0:後台設了網站圖示就用它(沒設時不給,各段路由自己的圖示檔照舊)。
    ...(shell.icons ? { icons: shell.icons } : {}),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  // 1.41.0:站台時區給所有 client component(useDateFormatter)。settings 是整包快取,
  // generateMetadata 已經讀過,這裡不會多一趟 D1。
  // 1.48.0:lang 跟著站台語系(core.locale)。原本寫死 "en",中文站的螢幕閱讀器會用
  // 英文念中文;宣告式插件的 script 也只能從這裡知道頁面是什麼語言。
  // 1.63.0:站台幣別(core.currency)同樣給所有 client component(useSiteCurrency / MoneyText)。
  const { timeZone, locale, currency } = await getSiteShell();
  return (
    <html
      lang={locale}
      className={cn("font-sans", geist.variable, interHeading.variable)}
    >
      <body>
        <DateTimeProvider timeZone={timeZone}>
          <CurrencyProvider currency={currency}>
            <TooltipProvider>{children}</TooltipProvider>
          </CurrencyProvider>
        </DateTimeProvider>
      </body>
    </html>
  );
}
