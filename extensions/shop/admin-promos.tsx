import { db } from "@/lib/db";
import { listPromos } from "@/ext/commerce-kit";
import { PromosAdmin } from "@/ext/commerce-kit/PromosAdmin";
import { canEditCurrentPage } from "@/lib/access-guards";

// 商店 adminPage:優惠碼 —— 管理 UI 在 commerce-kit(PromosAdmin),這裡只載資料。
// 儲存/刪除走 POST /api/ext/shop/promos/save|delete。只能看這一頁的角色沒有建立、編輯、刪除。

const PROMOS_TABLE = "ext_shop_promos";

export async function ShopPromosPage() {
  const [promos, canEdit] = await Promise.all([
    listPromos({ db: db() }, PROMOS_TABLE),
    canEditCurrentPage(),
  ]);
  return <PromosAdmin endpoint="/api/ext/shop" promos={promos} readOnly={!canEdit} />;
}
