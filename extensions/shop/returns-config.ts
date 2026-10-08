import { RETURN_SEARCH_FIELDS } from "@/ext/commerce-kit/returns";
import type { ReturnsConfig } from "@/ext/commerce-kit/returns-engine";
import type { AdminPageSearch } from "@/ext/record-search";
import type { SettingField } from "@/ext/types";
import { SHOP_RETURNS_PREFIX } from "./schema";

// 0.6.0:退貨的表(0004_returns 建立)與後台頁的搜尋宣告。API、後台頁、index.ts 共用。
// 前綴 ext_shop_return:退貨表是 ext_shop_return_requests / _events,ledger-kit 的交易
// 收據是 ext_shop_return_operations —— 不和其他插件共用收據表。

export const SHOP_RETURNS: ReturnsConfig = {
  ordersTable: "ext_shop_orders",
  prefix: SHOP_RETURNS_PREFIX,
};

/** 客人自己申請退貨:出貨後幾天內可以申請。0 = 不開放(預設),客人的訂單頁不會出現「申請退貨」。 */
export const CUSTOMER_RETURN_DAYS_KEY = "ext.shop.customerReturnDays";

/** 退貨的設定;index.ts 展開進 `settings`。數字怎麼讀(小數、負數、上限)在 commerce-kit 的 customerReturnDays。 */
export const SHOP_RETURN_SETTINGS: SettingField[] = [
  {
    key: "customerReturnDays",
    label: "客人可以申請退貨的天數（出貨後）",
    description: "0 是不開放。填 7，客人在出貨後 7 天內可以在訂單頁申請退貨，申請會出現在退貨管理。",
    type: "number",
    default: 0,
  },
];

/** 頂欄搜尋(退貨編號、訂單編號、姓名、電話、期間),⌘K 也找得到。 */
export const SHOP_RETURNS_SEARCH: AdminPageSearch = {
  placeholder: { en: "Return or order number, name or phone", "zh-Hant": "退貨編號、訂單編號、姓名或電話" },
  fields: RETURN_SEARCH_FIELDS,
  global: {
    id: "returns",
    label: { en: "Returns", "zh-Hant": "退貨" },
    table: `${SHOP_RETURNS_PREFIX}_requests`,
    key: "return_no",
    title: "customer_name",
    subtitle: ["return_no", "order_no"],
  },
};
