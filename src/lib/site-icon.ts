import type { Metadata } from "next";
import { getPlainSetting } from "@/lib/settings";

// 1.68.0:瀏覽器分頁上的網站圖示(favicon)從後台設定讀(core.siteIcon)。
//
// 只收兩種網址:站內路徑(/api/files/…、/brand/…)或 https 網址;其他一律當沒填。
// 值會寫進 <link rel="icon" href>,所以不收 javascript:、data: 這類。
//
// 資料夾裡放了 icon.png / icon.svg / apple-icon.png 的路由,Next 以檔案為準,這個設定在那裡
// 不會生效 —— 要讓後台改得到,那一段路由就不要放圖示檔,預設圖示改由 generateMetadata 給
// (siteIconMetadata() 回 undefined 時自己補)。

/** 設定值 → 可以放進 href 的網址;不合規則回 null。 */
export function siteIconHref(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  // 站內路徑:一個斜線開頭,不能是 //host(那是別的網站)。
  if (value.startsWith("/")) return value.startsWith("//") || value.includes("\\") ? null : value;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/** 後台有設網站圖示時的 metadata.icons;沒設(或設的不是合法網址)回 undefined。 */
export async function siteIconMetadata(): Promise<Metadata["icons"] | undefined> {
  const href = siteIconHref(await getPlainSetting<string>("core.siteIcon", ""));
  return href ? { icon: href, apple: href } : undefined;
}
