import type { SettingField } from "@/ext/types";
import { isPlaceholderEmail } from "@/lib/placeholder-email";

// 結帳頁的開關(shop 0.2.0)。三個設定都存在 settings 表(`ext.shop.<key>`),
// 由 public-pages.tsx 在伺服器讀出、經 resolveCheckoutOptions 正規化後交給
// CheckoutView。這裡沒有任何 React,所以能直接用 vitest 測。
//
// 「是否委派給受管訂單」**沒有**開關:commerce-kit 的結帳 handler 只看
// `commerce:orders` provider 在不在(shop-operations 啟用即委派),而且受管
// 標記表一旦存在就拒絕退回舊路徑(managed.ts)。shop 端若加一個「關閉」開關,
// 頁面會顯示舊表單、伺服器仍走受管結帳,兩邊對不上 —— 所以受管與否只由插件
// 啟用狀態決定,詳見 README「商城營運模式」。

export const REFERRAL_MODES = ["field", "link", "off"] as const;
export type ReferralMode = (typeof REFERRAL_MODES)[number];

// ScopedSettings / getSetting 收完整 key(ext.<extId>.<key>);與 index.ts 的
// 其他 *_KEY 常數同一慣例。
export const REFERRAL_MODE_KEY = "ext.shop.referralMode";
export const REQUIRE_CONTACT_KEY = "ext.shop.requireContact";
export const CHECKOUT_NOTICE_KEY = "ext.shop.checkoutNotice";

/** 結帳頁開關;index.ts 把這批展開進 `settings`,測試對著同一份驗證預設值。 */
export const SHOP_CHECKOUT_SETTINGS: SettingField[] = [
  {
    key: "referralMode",
    label: "推薦碼",
    description:
      "需啟用「商城營運」。顧客透過推薦連結進站時，推薦碼會保留 30 天。",
    type: "select",
    options: [
      { value: "field", label: "顯示欄位，推薦連結的推薦碼會自動帶入" },
      { value: "link", label: "不顯示欄位，只套用推薦連結帶入的推薦碼" },
      { value: "off", label: "不使用推薦碼" },
    ],
    default: "field",
  },
  {
    key: "requireContact",
    label: "電話與收件地址必填",
    description: "未啟用「商城營運」時才需要設定；啟用後一律必填。",
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
  /** shop-operations 啟用中:結帳走受管訂單(需登入、電話與地址必填、可帶推薦碼)。 */
  managedOrders: boolean;
  /** 受管模式下是否已登入;非受管一律 false(訪客結帳不需要登入)。 */
  signedIn: boolean;
  /**
   * 0.7.0:受管模式下,受管訂單那一邊(`commerce:orders` provider 的 `guestCheckout()`)
   * 開放沒登入的人結帳。true 時不擋登入,頂端改成「已經是會員？登入」。非受管一律 false。
   */
  guestCheckout: boolean;
  /** 推薦碼欄位模式;非受管一律 "off"(舊結帳路徑不認得 referralCode)。 */
  referralMode: ReferralMode;
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
  referralMode?: unknown;
  requireContact?: unknown;
  checkoutNotice?: unknown;
}): CheckoutOptions {
  const managedOrders = input.managedOrders === true;
  const referral =
    REFERRAL_MODES.find((mode) => mode === input.referralMode) ?? "field";
  return {
    managedOrders,
    signedIn: managedOrders && input.signedIn === true,
    guestCheckout: managedOrders && input.guestCheckout === true,
    referralMode: managedOrders ? referral : "off",
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
