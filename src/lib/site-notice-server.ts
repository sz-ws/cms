import { cache } from "react";
import { getPlainSetting } from "./settings";
import { getSiteTimeZone } from "./datetime-server";
import {
  resolveSiteNotice,
  resolveSiteNoticeWindow,
  SITE_NOTICE_KEYS,
  type SiteNotice,
  type SiteNoticeValues,
  type SiteNoticeWindow,
} from "./site-notice";

export type { SiteNotice, SiteNoticeWindow } from "./site-notice";

// 1.56.0:server 端的網站公告入口。拿到 null 就什麼都不畫。
//
// 不另外快取:五個值都從 settings 的整包讀取來(settings.ts 的 readAll —— 同一個
// request 只讀一次,跨 request 用版本戳比對),所以這裡每次呼叫只多幾次 Map 查找。
// React cache() 讓同一頁的多個呼叫者(core 外框 + 站台頁首)共用一次結果。
//
// 2.0:兩個入口。
//   - getSiteNoticeWindow:存起來的公開頁用(core 的 (public)/layout.tsx)。不看現在幾點,只給公告與
//     時段;出不出現由瀏覽器決定(SiteNoticeBar)。設定一存,publicContentChanged 讓頁面重算。
//   - getSiteNotice:逐請求渲染的頁面用(站台自己 force-dynamic 的外框)。以當下時間判斷,到了開始日或
//     過了結束日,下一個請求就換過來。**不可**用在存起來的頁面:那會把「渲染那一刻」的答案存給每個訪客。

const readNoticeValues = cache(async (): Promise<[SiteNoticeValues, string]> => {
  const [enabled, text, href, startsOn, endsOn, timeZone] = await Promise.all([
    getPlainSetting<unknown>(SITE_NOTICE_KEYS.enabled),
    getPlainSetting<unknown>(SITE_NOTICE_KEYS.text),
    getPlainSetting<unknown>(SITE_NOTICE_KEYS.href),
    getPlainSetting<unknown>(SITE_NOTICE_KEYS.startsOn),
    getPlainSetting<unknown>(SITE_NOTICE_KEYS.endsOn),
    getSiteTimeZone(),
  ]);
  return [{ enabled, text, href, startsOn, endsOn }, timeZone];
});

export const getSiteNoticeWindow = cache(async (): Promise<SiteNoticeWindow | null> => {
  const [values, timeZone] = await readNoticeValues();
  return resolveSiteNoticeWindow(values, timeZone);
});

export const getSiteNotice = cache(async (): Promise<SiteNotice | null> => {
  const [values, timeZone] = await readNoticeValues();
  return resolveSiteNotice(values, Date.now(), timeZone);
});
