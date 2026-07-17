import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
// Self-hosted Chiron Hei HK (昭源黑體) TC fallback face declarations. The css
// lives in public/ (kept out of Tailwind @source scanning) but is imported here
// so Next bundles it; its unicode-range-sliced @font-face set means the browser
// only fetches the woff2 slices a page actually needs. No CJK preload — Latin
// keeps rendering via Geist/Inter.
import "../../public/fonts/chiron-hei-hk/chiron-hei-hk.css";
import { Geist, Inter } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Distinct var names (not --font-sans/--font-heading) so they don't collide with
// the Tailwind theme tokens of the same name — the theme composes the full stack
// (Latin face → Chiron Hei HK → system) from these in globals.css @theme.
const interHeading = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});
const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });

// 01 §3 快取決策(分層):render 層維持 dynamic,資料層各自快取。
//
// 為何 render 層仍 force-dynamic:所有頁面的資料都來自 D1(getExtRuntime、settings、
// content),而 D1 只在 request context(getCloudflareContext)下可用,build 期無法
// 靜態產生;public 頁面本身也依 request 決定要渲染哪個 extension component。故整站無
// 可安全 ISR 的頁面,root layout 起標記 force-dynamic 免去每個路由各自判定的雜訊。
// (API route handlers 不需此標記:有 dynamic segment 或讀 cookies/req.url,本來就 dynamic。)
//
// 動態渲染的成本改由「資料層快取」壓低,不靠頁面靜態化:
//   - settings 全表讀:src/lib/settings.ts stamp-based module memo(每 request 一次輕量
//     stamp query 驗新鮮度,命中則重用已 parse 的整包 Map;寫入即時可見,非 TTL)。
//   - extension runtime(rows + interpret):src/ext/loader.ts stamp-based module memo
//     (每 request 一次輕量 stamp query 驗新鮮度,命中則省下兩個 SELECT + 每列 zod parse)。
//   - public content rows:src/ext/dx/content-cache.ts unstable_cache + tag 精準失效。
//   - robots/sitemap/feed:src/ext/dx/seo-cache.ts isolate TTL(5 分鐘)。
// 之後每個新增的 page/layout 都不得覆寫為靜態(見 08 Phase 0 步驟 2)。
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "CMS",
  description: "Cloudflare Workers CMS",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={cn("font-sans", geist.variable, interHeading.variable)}
    >
      <body>
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
