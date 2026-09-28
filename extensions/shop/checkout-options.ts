import type { SettingField } from "@/ext/types";
import { isPlaceholderEmail } from "@/lib/placeholder-email";

// 結帳頁的開關(shop 0.2.0)。設定存在 settings 表(`ext.shop.<key>`),由 public-pages.tsx 在
// 伺服器讀出、經 resolveCheckoutOptions 正規化後交給 CheckoutView。這裡沒有任何 React,所以能直接用
// vitest 測。
//
// 「是否交給訂單管理插件」**沒有**開關:commerce-kit 的結帳 handler 只看 `commerce:orders` provider
// 在不在(接手訂單的插件啟用即交給它)。shop 端若加一個「關閉」開關,頁面會顯示舊表單、伺服器仍交給
// 插件,兩邊對不上 —— 所以只由插件啟用狀態決定,詳見 README「訂單管理插件」。
// 0.9.0:額外的結帳欄位由插件以 commerce-kit 的結帳欄位(commerce:checkout-fields)宣告,不在這裡。

export const REQUIRE_CONTACT_KEY = "ext.shop.requireContact";
export const CHECKOUT_NOTICE_KEY = "ext.shop.checkoutNotice";

/** 結帳頁開關;index.ts 把這批展開進 `settings`,測試對著同一份驗證預設值。 */
export const SHOP_CHECKOUT_SETTINGS: SettingField[] = [
  {
    key: "requireContact",
    label: "電話與收件地址必填",
    description: "由訂單管理插件接手結帳時，照該插件的要求。",
    type: "boolean",
    default: false,
  },
  {
    key: "checkoutNotice",
    label: "結帳頁說明",
    description: "顯示在結帳頁最上方，例如出貨時間、預購或自取方式。",
    type: "textarea",
    default: "",
  },
];

export interface CheckoutOptions {
  /** 有訂單管理插件接手結帳(`commerce:orders`)。 */
  managedOrders: boolean;
  /** 受管模式下是否已登入;非受管一律 false(訪客結帳不需要登入)。 */
  signedIn: boolean;
  /**
   * 0.7.0:受管模式下,受管訂單那一邊(`commerce:orders` provider 的 `guestCheckout()`)
   * 開放沒登入的人結帳。true 時不擋登入,頂端改成「已經是會員？登入」。非受管一律 false。
   */
  guestCheckout: boolean;
  /** 電話與收件地址是否必填;受管模式一律 true(伺服器端 schema 要求)。 */
  requireContact: boolean;
  /** 結帳頁最上方的說明,已 trim;空字串 = 不顯示。 */
  notice: string;
}

/**
 * 把「插件啟用狀態 + 三個設定的原始值」正規化成 CheckoutView 用的選項。
 * 設定值來自 D1(JSON),型別不保證 —— 不合法的值一律退回預設,不擋結帳。
 * 冪等:餵回自己的輸出會得到相同結果,所以 CheckoutView 也能對 props 再跑一次。
 */
export function resolveCheckoutOptions(input: {
  managedOrders?: boolean;
  signedIn?: boolean;
  guestCheckout?: unknown;
  requireContact?: unknown;
  checkoutNotice?: unknown;
}): CheckoutOptions {
  const managedOrders = input.managedOrders === true;
  return {
    managedOrders,
    signedIn: managedOrders && input.signedIn === true,
    guestCheckout: managedOrders && input.guestCheckout === true,
    requireContact: managedOrders || input.requireContact === true,
    notice:
      typeof input.checkoutNotice === "string" ? input.checkoutNotice.trim() : "",
  };
}

/** 結帳表單一開始帶入的聯絡資料(0.7.0)。 */
export interface CheckoutContact {
  name?: string;
  email?: string;
}

/**
 * 已登入的人結帳時,Email 與姓名先帶入帳號上的資料,不必再打一次(欄位照樣能改)。
 * 拿不到真實 Email 的第三方登入(placeholder)不帶;姓名只是 Email @ 前面那段(帳號
 * 建立時沒填名字的預設值)也不帶 —— 那不是收件人的名字。
 */
export function checkoutContact(user: { email?: string | null; name?: string | null } | null): CheckoutContact {
  if (!user) return {};
  const rawEmail = (user.email ?? "").trim();
  const email = isPlaceholderEmail(rawEmail) ? "" : rawEmail;
  const name = (user.name ?? "").trim();
  const local = email.split("@")[0] ?? "";
  return {
    ...(email ? { email } : {}),
    ...(name && name !== local && name !== email ? { name } : {}),
  };
}
