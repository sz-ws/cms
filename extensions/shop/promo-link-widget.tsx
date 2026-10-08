import { PromoLinkCapture } from "./PromoLinkCapture";

/**
 * 掛在每一個公開頁(filter:publicWidgets)的那一個元件:記優惠碼連結(PromoLinkCapture)。
 * 這一層是伺服器元件 —— 公開頁的外框只收函式,client 元件要包一層才放得進去。
 */
export function PromoLinkWidget() {
  return <PromoLinkCapture />;
}
