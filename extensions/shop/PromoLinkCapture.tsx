"use client";

import { useEffect } from "react";
import { rememberPromoLink } from "@/ext/commerce-kit/promo-link";

/**
 * 優惠碼的分享連結(commerce-kit promo-link):這一頁的網址帶 ?promo=代碼 就記下來,結帳頁先帶入並套用。
 * 不畫任何東西;瀏覽器不讓存時什麼都不做。
 */
export function PromoLinkCapture() {
  useEffect(() => {
    rememberPromoLink(window.location.href);
  }, []);
  return null;
}
