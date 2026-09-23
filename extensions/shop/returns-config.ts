import { RETURN_SEARCH_FIELDS } from "@/ext/commerce-kit/returns";
import type { ReturnsConfig } from "@/ext/commerce-kit/returns-engine";
import type { AdminPageSearch } from "@/ext/record-search";
import { SHOP_RETURNS_PREFIX } from "./schema";

// 0.6.0:退貨的表(0004_returns 建立)與後台頁的搜尋宣告。API、後台頁、index.ts 共用。
// 前綴 ext_shop_return:退貨表是 ext_shop_return_requests / _events,ledger-kit 的交易
// 收據是 ext_shop_return_operations —— 不和其他插件共用收據表。

export const SHOP_RETURNS: ReturnsConfig = {
  ordersTable: "ext_shop_orders",
  prefix: SHOP_RETURNS_PREFIX,
};

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
