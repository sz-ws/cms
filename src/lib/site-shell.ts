import type { Metadata } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { getSetting } from "@/lib/settings";
import { siteIconMetadata } from "@/lib/site-icon";
import { getSiteTimeZone } from "@/lib/datetime-server";
import { getSiteCurrency } from "@/lib/units-server";
import { getLocale } from "@/lib/i18n/server";
import { normalizeTimeZone } from "@/lib/datetime";
import { DEFAULT_CURRENCY } from "@/lib/units";
import type { Locale } from "@/lib/i18n";

// [core] 根 layout(src/app/layout.tsx)用的站台外殼設定:標題、描述、圖示、語系、時區、幣別。
//
// 2.0 拿掉了根 layout 的 force-dynamic,於是 `next build` 會經由根 layout 預先產生 404 頁
// (/_not-found)。建置時沒有網站的 D1(OpenNext 在建置時給的是本機空的 binding,表都不存在),
// 所以建置時一律回內建的預設值,不讀資料庫。
//
// 這只影響建置時算出來的頁面,而公開頁一頁都不在建置時算(見 (public)/[[...slug]]/page.tsx),
// 後台與登入頁都是 force-dynamic —— 實際上只有建置時的 404 頁拿到預設值。正式環境的每一個
// 請求都照常讀設定。判斷靠 Next 自己在建置時設的 NEXT_PHASE,不是 try/catch:讀設定失敗不能被
// 悄悄換成預設值存進頁面裡。

export interface SiteShell {
  title: string;
  description: string | undefined;
  icons: Metadata["icons"] | undefined;
  locale: Locale;
  timeZone: string;
  currency: string;
}

/** 還沒設定過的站顯示產品名,不是別人的品牌。 */
const DEFAULT_TITLE = "CMS by szws";

function isBuildTime(): boolean {
  return process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD;
}

export async function getSiteShell(): Promise<SiteShell> {
  if (isBuildTime()) {
    return {
      title: DEFAULT_TITLE,
      description: undefined,
      icons: undefined,
      locale: "en",
      timeZone: normalizeTimeZone(undefined),
      currency: DEFAULT_CURRENCY,
    };
  }
  const [title, description, icons, locale, timeZone, currency] = await Promise.all([
    getSetting<string>("core.siteTitle"),
    getSetting<string>("core.siteDescription"),
    siteIconMetadata(),
    getLocale(),
    getSiteTimeZone(),
    getSiteCurrency(),
  ]);
  return {
    title: title?.trim() || DEFAULT_TITLE,
    description: description?.trim() || undefined,
    icons,
    locale,
    timeZone,
    currency,
  };
}
