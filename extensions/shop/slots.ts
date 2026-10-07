import { defineSlot } from "@/ext/slots";
import type { CheckoutViewProps } from "./public-pages";

// 商店公開頁的插槽(0.12.0,core 1.74.0;機制見 src/ext/slots.ts)。別的插件或站台那一層用 wrap 包起來:
// 拿得到這一頁的 props 與原本的內容(children),可以照畫、在外面多包一層、或換成自己的。
// 版面(ShopPageShell:白底單欄與標題)在插槽外面,填的人不用管。

/**
 * 購物車頁(/shop/cart)的內容。預設是商店的購物車(CartView)。
 * 例:數量有規矩的店(只能一箱一箱買)換成自己的購物車(同一份 cart-store 的資料)。
 */
export const ShopCart = defineSlot<{
  /** 空的購物車「繼續購物」連去哪;沒有 = 回首頁。 */
  shopHref?: string;
}>("shop.cart");

/**
 * 結帳頁(/shop/checkout)的表單。預設是 <CheckoutView {...props} />,props 就是它收到的那一包
 * (伺服器讀好的設定、付款方式、結帳欄位、登入狀態)。
 * 例:會員插件在表單前多一步(訪客先確認 Email)、先帶入會員存的電話與地址。
 * 要換掉表單的 props(例如鎖住 Email、成立訂單之後多畫一塊)就自己畫 <CheckoutView>(./CheckoutView),不畫 children
 * —— 這樣做的話,排在它前面(更裡面)的 wrap 就不會出現,所以同一個站只該有一個這種填法。
 */
export const ShopCheckout = defineSlot<CheckoutViewProps>("shop.checkout");
