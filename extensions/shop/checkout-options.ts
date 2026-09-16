import type { SettingField } from "@/ext/types";

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
    referralMode: managedOrders ? referral : "off",
    requireContact: managedOrders || input.requireContact === true,
    notice:
      typeof input.checkoutNotice === "string" ? input.checkoutNotice.trim() : "",
  };
}
