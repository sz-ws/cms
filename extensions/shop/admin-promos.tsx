import { db } from "@/lib/db";
import { listPromos } from "@/ext/commerce-kit";
import { PromosAdmin } from "@/ext/commerce-kit/PromosAdmin";
import { AdminPromoFormFields } from "@/ext/core-slots";
import { slotParts } from "@/components/Slot";
import { canEditCurrentPage } from "@/lib/access-guards";

// 商店 adminPage:優惠碼 —— 管理 UI 在 commerce-kit(PromosAdmin),這裡只載資料。
// 儲存/刪除走 POST /api/ext/shop/promos/save|delete。只能看這一頁的角色沒有建立、編輯、刪除。
//
// 表單裡的插槽(core-slots.ts 的 AdminPromoFormFields)在這裡先問好誰填了什麼,再交給 client 那一邊擺;
// 只能看的角色沒有表單,就不用問。now:列表據此分出尚未開始、已過期、已用完。

const PROMOS_TABLE = "ext_shop_promos";

/** 這一頁要的資料與這次請求的時間(Date.now() 寫在元件 body 會被 react-hooks/purity 擋,同其他後台頁)。 */
async function loadPromosPage() {
  const now = Date.now();
  const [promos, canEdit] = await Promise.all([
    listPromos({ db: db() }, PROMOS_TABLE),
    canEditCurrentPage(),
  ]);
  return { now, promos, canEdit, formFields: canEdit ? await slotParts(AdminPromoFormFields, {}) : undefined };
}

export async function ShopPromosPage() {
  const { now, promos, canEdit, formFields } = await loadPromosPage();
  return <PromosAdmin endpoint="/api/ext/shop" promos={promos} readOnly={!canEdit} now={now} formFields={formFields} />;
}
