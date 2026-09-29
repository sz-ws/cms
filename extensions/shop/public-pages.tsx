import { getSetting } from "@/lib/settings";
import { db } from "@/lib/db";
import { publicSignInPage } from "@/lib/sign-in-page";
import { listPromos, parseShippingConfig } from "@/ext/commerce-kit";
import { ORDERS_CAPABILITY, storefrontOf, type OrderManager } from "@/ext/commerce-kit/order-manager";
import { CartView } from "./CartView";
import { CheckoutView } from "./CheckoutView";
import { PageHeader } from "./PageHeader";
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
  children,
}: {
  /** 頁面標題;不給 = 內容自己畫(結帳頁,見 PageHeader.tsx)。 */
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-xl px-6 py-14">
      {title ? <PageHeader title={title} /> : null}
      {children}
    </main>
  );
}

const ORDERS_TABLE = "ext_shop_orders";
const CHECKOUT_PATH = "/shop/checkout";

/**
 * 結帳頁的「登入」:直接連到網站的登入頁(有插件宣告 signInPage 的話),登入完回結帳頁。
 * 沒有就是 /login(它也會轉到登入頁,只是多繞一次)。
 */
async function checkoutSignInHref(): Promise<string> {
  const page = (await publicSignInPage()) ?? "/login";
  return `${page}?next=${encodeURIComponent(CHECKOUT_PATH)}`;
}

/**
 * /shop/cart。shopHref:空的購物車「繼續購物」連去哪;站台的殼直接畫這一頁時給自己的商品頁,
 * 經由 publicRoutes 派送時沒有(回首頁)。
 */
export function ShopCartPage({ shopHref }: { shopHref?: string; params?: Record<string, string> }) {
  return (
    <PageShell title="購物車">
      <CartView shopHref={shopHref} />
    </PageShell>
  );
}

/**
 * /shop/checkout。標題與「回購物車」由 CheckoutView 畫(成立訂單之後換成「訂單已成立」)。shopHref 同
 * ShopCartPage:空的結帳頁「繼續購物」連去哪,沒給回首頁。
 */
export async function ShopCheckoutPage({ shopHref }: { shopHref?: string; params?: Record<string, string> } = {}) {
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
  const [storefront, reportSpec, fields, signInHref] = await Promise.all([
    manager ? storefrontOf(manager) : null,
    loadTransferReportSpec(providers),
    loadCheckoutFields(providers),
    checkoutSignInHref(),
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
    <PageShell>
      <CheckoutView
        {...options}
        cardEnabled={Boolean(cardProvider.trim())}
        transferEnabled={Boolean(transferProvider.trim())}
        shippingConfig={shippingConfig}
        promoEnabled={promos.some((p) => p.enabled)}
        reportSpec={reportSpec}
        fields={fields}
        signInHref={signInHref}
        shopHref={shopHref}
        contact={checkoutContact(user)}
      />
    </PageShell>
  );
}
