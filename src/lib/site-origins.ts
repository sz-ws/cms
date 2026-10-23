import { getPlainSetting } from "./settings";

// 網站自己的網址(1.82.0)。同一份網站可以由兩個網址打開:網站網址(core.siteUrl;搜尋引擎、sitemap、
// canonical、Email 裡的連結都以它為準)與分享用網址(core.shareUrl,例如好記的短網域)。
//
// 購物車(localStorage)與登入的 cookie 都只屬於一個網址,換網址等於換一個瀏覽器:購物車是空的、沒登入。
// 所以客人從哪一個網址進來,第三方登入的回呼與付款完的返回就回到哪一個(visitorOrigin / ownOrigin)。
// 分享出去的連結用分享用網址開頭(shareOrigin)。別的網址(workers.dev、預覽網址)不算網站自己的,
// 照舊回網站網址。兩個都不是 secret,用 getPlainSetting 讀(不經過 extension runtime)。

/** "https://a.test/x/" → "https://a.test";不是 http(s) 網址回 ""。 */
export function originOf(url: unknown): string {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) return "";
  try {
    return new URL(url.trim()).origin;
  } catch {
    return "";
  }
}

/** 網站網址與分享用網址的 origin:有設、格式對的才算,網站網址在前,一樣的只留一個。 */
export async function siteOrigins(): Promise<string[]> {
  const [site, share] = await Promise.all([
    getPlainSetting<string>("core.siteUrl", ""),
    getPlainSetting<string>("core.shareUrl", ""),
  ]);
  return [...new Set([originOf(site), originOf(share)].filter(Boolean))];
}

/** 分享連結的開頭:分享用網址,沒設就網站網址;兩個都沒設是 ""(由呼叫端決定只寫路徑或用請求的網址)。 */
export async function shareOrigin(): Promise<string> {
  const [share, site] = await Promise.all([
    getPlainSetting<string>("core.shareUrl", ""),
    getPlainSetting<string>("core.siteUrl", ""),
  ]);
  return originOf(share) || originOf(site);
}

/**
 * 網址或 Host 標頭("https://a.test/x"、"a.test")是網站自己的網址之一就回那個 origin,否則 ""。
 * 比的是 host;回的 scheme 照設定裡寫的(Host 標頭沒有 scheme)。
 */
export function ownOrigin(urlOrHost: string | null | undefined, origins: readonly string[]): string {
  const value = urlOrHost?.trim().toLowerCase();
  if (!value) return "";
  let host: string;
  try {
    host = value.includes("://") ? new URL(value).host : new URL(`https://${value}`).host;
  } catch {
    return "";
  }
  return origins.find((origin) => new URL(origin).host === host) ?? "";
}

/**
 * 這個請求是從網站的哪一個網址來的:網站網址或分享用網址;別的網址、或不在請求裡(cron、after()、
 * 測試)回 ""。用在只拿得到設定、拿不到 Request 的地方(例如插件呼叫的付款 provider)。
 */
export async function visitorOrigin(): Promise<string> {
  const [origins, host] = await Promise.all([siteOrigins(), requestHost()]);
  return ownOrigin(host, origins);
}

/**
 * 這個請求的 Host 標頭;不在請求裡回 null。Next 用 throw 傳遞自己的控制訊號,那些交給 unstable_rethrow
 * 丟回去(同 request-stamps.ts 的 isPublicPageRequest);兩個 import 是動態的,理由也一樣。
 */
async function requestHost(): Promise<string | null> {
  let rethrow: (error: unknown) => void = () => {};
  try {
    const [{ headers }, { unstable_rethrow }] = await Promise.all([
      import("next/headers"),
      import("next/navigation"),
    ]);
    rethrow = unstable_rethrow;
    return (await headers()).get("host");
  } catch (e) {
    rethrow(e);
    return null;
  }
}
