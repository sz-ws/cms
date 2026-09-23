import { getSetting } from "@/lib/settings";
import { parseShippingConfig } from "@/ext/commerce-kit";
import { ShippingEditor } from "@/ext/commerce-kit/ShippingEditor";
import { canEditCurrentPage } from "@/lib/access-guards";

// 商店 adminPage:運費設定 —— 編輯器本體在 commerce-kit(ShippingEditor,
// 含即時試算),這裡只讀當前設定餵進去。儲存走 POST /api/ext/shop/shipping-config。
// 只能看這一頁的角色:欄位不能改、沒有儲存,試算照常。

export async function ShopShippingPage() {
  const [raw, canEdit] = await Promise.all([
    getSetting<string>("ext.shop.shippingConfig", ""),
    canEditCurrentPage(),
  ]);
  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-xl text-[13px] leading-relaxed text-black/55">
        配送方式是客人結帳時挑的選項；規則由上往下套用（滿額免運、離島加收…）。右側試算和結帳頁算法相同，這裡看到多少，客人就付多少。
      </p>
      <ShippingEditor endpoint="/api/ext/shop" initial={parseShippingConfig(raw)} readOnly={!canEdit} />
    </div>
  );
}
