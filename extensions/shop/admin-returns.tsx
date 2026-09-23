import { ReturnsAdminPage } from "@/ext/commerce-kit/returns-admin";
import { SHOP_RETURNS } from "./returns-config";

// 商店 adminPage:退貨管理。畫面與資料都在 commerce-kit(returns-admin.tsx),這裡只給表名與網址。

export function ShopReturnsPage({
  searchParams,
}: {
  params: Record<string, string>;
  searchParams: Record<string, string>;
}) {
  return (
    <ReturnsAdminPage
      extId="shop"
      slug="returns"
      config={SHOP_RETURNS}
      ordersPage="/admin/ext/shop"
      searchParams={searchParams}
    />
  );
}
