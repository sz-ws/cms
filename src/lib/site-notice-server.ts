import { cache } from "react";
import { getPlainSetting } from "./settings";
import { getSiteTimeZone } from "./datetime-server";
import { resolveSiteNotice, SITE_NOTICE_KEYS, type SiteNotice } from "./site-notice";

export type { SiteNotice } from "./site-notice";

// 1.56.0:server 端的網站公告入口。公開頁的外框(core 的 (public)/layout.tsx,或站台
// 自己的頁首)呼叫它,拿到 null 就什麼都不畫。
//
// 不另外快取:五個值都從 settings 的整包讀取來(settings.ts 的 readAll —— 同一個
// request 只讀一次,跨 request 用版本戳比對,公開頁綁了 CMS_KV 時戳從 KV 拿),
// 所以這裡每次呼叫只多幾次 Map 查找。日期每個 request 以當下時間重算,
// 到了開始日或過了結束日,下一個請求就換過來,不必有人再存一次設定。
// React cache() 讓同一頁的多個呼叫者(core 外框 + 站台頁首)共用一次結果。

export const getSiteNotice = cache(async (): Promise<SiteNotice | null> => {
  const [enabled, text, href, startsOn, endsOn, timeZone] = await Promise.all([
    getPlainSetting<unknown>(SITE_NOTICE_KEYS.enabled),
    getPlainSetting<unknown>(SITE_NOTICE_KEYS.text),
    getPlainSetting<unknown>(SITE_NOTICE_KEYS.href),
    getPlainSetting<unknown>(SITE_NOTICE_KEYS.startsOn),
    getPlainSetting<unknown>(SITE_NOTICE_KEYS.endsOn),
    getSiteTimeZone(),
  ]);
  return resolveSiteNotice({ enabled, text, href, startsOn, endsOn }, Date.now(), timeZone);
});
