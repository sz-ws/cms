import { getSetting } from "@/lib/settings";
import { parseShippingConfig } from "@/ext/commerce-kit";
import { ShippingEditor } from "@/ext/commerce-kit/ShippingEditor";

// 商店 adminPage:運費設定 —— 編輯器本體在 commerce-kit(ShippingEditor,
// 含即時試算),這裡只讀當前設定餵進去。儲存走 POST /api/ext/shop/shipping-config。

export async function ShopShippingPage() {
  const raw = await getSetting<string>("ext.shop.shippingConfig", "");
  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-xl text-[13px] leading-relaxed text-black/55">
        配送方式是客人結帳時挑的選項;規則由上往下套用(滿額免運、離島加收…)。
        右側試算跟結帳頁用同一套引擎 —— 這裡看到多少,客人就付多少。
      </p>
      <ShippingEditor endpoint="/api/ext/shop" initial={parseShippingConfig(raw)} />
    </div>
  );
}
