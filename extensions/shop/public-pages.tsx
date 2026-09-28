import Link from "next/link";
import { getSetting } from "@/lib/settings";
import { db } from "@/lib/db";
import { listPromos, parseShippingConfig } from "@/ext/commerce-kit";
import { ORDERS_CAPABILITY, storefrontOf, type OrderManager } from "@/ext/commerce-kit/order-manager";
import { CartView } from "./CartView";
import { CheckoutView } from "./CheckoutView";
import { loadCheckoutFields, loadTransferReportSpec, shopProviders } from "./shop-providers";
import {
  CHECKOUT_NOTICE_KEY,
  REQUIRE_CONTACT_KEY,
  checkoutContact,
  resolveCheckoutOptions,
} from "./checkout-options";

// 商店公開頁(server 殼):/shop/cart 與 /shop/checkout。
// 內容本體是 client 元件(購物車在 localStorage);這裡只讀設定決定付款方式
// 可見性,並給一個安靜的白底單欄版面(外框由 publicHeader/publicFooter filter
// 決定,本 extension 不越權)。

function PageShell({
  title,
  backHref,
  backLabel,
  children,
}: {
  title: string;
  backHref?: string;
  backLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-xl px-6 py-14">
      <header className="mb-8 flex items-baseline justify-between gap-3">
        <h1 className="text-[24px] font-semibold tracking-[-0.02em] text-black/85">
          {title}
        </h1>
        {backHref ? (
          <Link
            href={backHref}
            className="text-[13px] text-black/55 underline underline-offset-4"
          >
            {backLabel}
          </Link>
        ) : null}
      </header>
      {children}
    </main>
  );
}

const ORDERS_TABLE = "ext_shop_orders";

export function ShopCartPage() {
  return (
    <PageShell title="購物車">
      <CartView />
    </PageShell>
  );
}

export async function ShopCheckoutPage() {
  const [
    cardProvider,
    transferProvider,
    shippingRaw,
    promos,
    requireContact,
    checkoutNotice,
  ] = await Promise.all([
    getSetting<string>("ext.shop.cardProvider", ""),
    getSetting<string>("ext.shop.transferProvider", ""),
    getSetting<string>("ext.shop.shippingConfig", ""),
    // 優惠碼欄位只在店家真的建過碼時出現(空店不擺一個永遠沒用的輸入框)。
    listPromos({ db: db() }, "ext_shop_promos"),
    // 結帳頁開關;原始值交給 resolveCheckoutOptions 正規化(壞值退回預設)。
    getSetting<unknown>(REQUIRE_CONTACT_KEY, false),
    getSetting<unknown>(CHECKOUT_NOTICE_KEY, ""),
  ]);
  // 運費設定與結帳 handler 走同一個 parse(壞設定 → 未啟用,不擋結帳)。
  const shippingConfig = parseShippingConfig(shippingRaw);
  const { getSessionUser } = await import("@/lib/auth");
  // 受管訂單:有插件以 `commerce:orders` 接手訂單表,結帳就交給它(commerce-kit 依 provider 判斷,
  // shop 端沒有開關 —— 理由見 checkout-options.ts 檔頭)。結帳頁照它的 storefront() 畫。
  const user = await getSessionUser();
  const providers = await shopProviders();
  const manager = providers.getById<OrderManager>(ORDERS_CAPABILITY, ORDERS_TABLE);
  const [storefront, reportSpec, fields] = await Promise.all([
    manager ? storefrontOf(manager) : null,
    loadTransferReportSpec(providers),
    loadCheckoutFields(providers),
  ]);
  const options = resolveCheckoutOptions({
    managedOrders: storefront !== null,
    signedIn: storefront !== null && !!user,
    guestCheckout: storefront?.signIn === "optional",
    requireContact: storefront ? storefront.requireContact : requireContact,
    ordersHref: storefront?.ordersHref ?? null,
    checkoutNotice,
  });
  return (
    <PageShell title="結帳" backHref="/shop/cart" backLabel="回購物車">
      <CheckoutView
        {...options}
        cardEnabled={Boolean(cardProvider.trim())}
        transferEnabled={Boolean(transferProvider.trim())}
        shippingConfig={shippingConfig}
        promoEnabled={promos.some((p) => p.enabled)}
        reportSpec={reportSpec}
        fields={fields}
        contact={checkoutContact(user)}
      />
    </PageShell>
  );
}
