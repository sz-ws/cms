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

// 01 §3 快取決策:全站 dynamic rendering,root layout 起就標記 force-dynamic;
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
