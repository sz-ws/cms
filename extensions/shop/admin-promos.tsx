import { db } from "@/lib/db";
import { listPromos } from "@/ext/commerce-kit";
import { PromosAdmin } from "@/ext/commerce-kit/PromosAdmin";

// 商店 adminPage:優惠碼 —— 管理 UI 在 commerce-kit(PromosAdmin),這裡只載資料。
// 儲存/刪除走 POST /api/ext/shop/promos/save|delete。

const PROMOS_TABLE = "ext_shop_promos";

export async function ShopPromosPage() {
  const promos = await listPromos({ db: db() }, PROMOS_TABLE);
  return <PromosAdmin endpoint="/api/ext/shop" promos={promos} />;
}
