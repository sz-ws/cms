import { getSetting } from "@/lib/settings";
import { db } from "@/lib/db";
import { publicSignInPage } from "@/lib/sign-in-page";
import { listPromos, parseShippingConfig } from "@/ext/commerce-kit";
import { CATALOG_EXT_ID, CATALOG_LIST_PATH } from "@/ext/commerce-kit/catalog";
import { ORDERS_CAPABILITY, storefrontOf, type OrderManager } from "@/ext/commerce-kit/order-manager";
import { Slot } from "@/components/Slot";
import type { ComponentProps } from "react";
import { CartView } from "./CartView";
import { CheckoutView } from "./CheckoutView";
import { PageHeader } from "./PageHeader";
import { ShopCart, ShopCheckout } from "./slots";
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
//
// 0.12.0:兩頁的內容各是一個插槽(./slots.ts)。別的插件要在結帳表單前多一步、站台要換成自己的購物車,
// 填插槽就好,不必另外開一個路由檔把這一頁重組一次。

/** 商店頁的版面(白底單欄)。站台自己組結帳頁(例如在表單前多一步)時也用它,和原本的頁面一樣寬。 */
export function ShopPageShell({
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
 * 「繼續購物」沒指定時連去哪:商品目錄開著就是它的列表頁;沒開就不指定(購物車與結帳表單自己回首頁)。
 * @/ext/loader 動態載入:loader → registry → 本插件,靜態 import 會繞成循環。
 */
async function defaultShopHref(): Promise<string | undefined> {
  const { getExtRuntime } = await import("@/ext/loader");
  return (await getExtRuntime()).byId(CATALOG_EXT_ID) ? CATALOG_LIST_PATH : undefined;
}

/**
 * 結帳頁的「登入」:直接連到網站的登入頁(有插件宣告 signInPage 的話),登入完回結帳頁。
 * 沒有就是 /login(它也會轉到登入頁,只是多繞一次)。
 */
async function checkoutSignInHref(): Promise<string> {
  const page = (await publicSignInPage()) ?? "/login";
  return `${page}?next=${encodeURIComponent(CHECKOUT_PATH)}`;
}

/**
 * /shop/cart。shopHref:空的購物車「繼續購物」連去哪;站台的殼直接畫這一頁時可以給自己的商品頁,
 * 沒給(經由 publicRoutes 派送)就是 defaultShopHref()。內容是插槽 ShopCart。
 */
export async function ShopCartPage({ shopHref }: { shopHref?: string; params?: Record<string, string> }) {
  const href = shopHref ?? (await defaultShopHref());
  return (
    <ShopPageShell title="購物車">
      <Slot of={ShopCart} props={{ shopHref: href }}>
        <CartView shopHref={href} />
      </Slot>
    </ShopPageShell>
  );
}

export type CheckoutViewProps = ComponentProps<typeof CheckoutView>;

/**
 * 結帳表單要的資料(伺服器讀設定、付款方式、結帳欄位、訂單管理插件的 storefront())。ShopCheckoutPage 用它;
 * 站台要自己組結帳頁(例如在表單前多一步、給 afterOrder 這類只能從 client 傳的 prop)時也用它,把結果交給
 * 自己的 client 元件去畫 CheckoutView。
 */
export async function loadShopCheckoutProps({ shopHref: givenShopHref }: { shopHref?: string } = {}): Promise<CheckoutViewProps> {
  const shopHref = givenShopHref ?? (await defaultShopHref());
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
  return {
    ...options,
    cardEnabled: Boolean(cardProvider.trim()),
    transferEnabled: Boolean(transferProvider.trim()),
    shippingConfig,
    promoEnabled: promos.some((p) => p.enabled),
    reportSpec,
    fields,
    signInHref,
    shopHref,
    contact: checkoutContact(user),
  };
}

/**
 * /shop/checkout。標題與「回購物車」由 CheckoutView 畫(成立訂單之後換成「訂單已成立」)。shopHref 同
 * ShopCartPage:空的結帳頁「繼續購物」連去哪。表單是插槽 ShopCheckout。
 */
export async function ShopCheckoutPage({ shopHref }: { shopHref?: string; params?: Record<string, string> } = {}) {
  const checkout = await loadShopCheckoutProps({ shopHref });
  return (
    <ShopPageShell>
      <Slot of={ShopCheckout} props={checkout}>
        <CheckoutView {...checkout} />
      </Slot>
    </ShopPageShell>
  );
}
