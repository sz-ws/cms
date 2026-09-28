import Link from "next/link";
import { getSetting } from "@/lib/settings";
import { db } from "@/lib/db";
import { listPromos, parseShippingConfig } from "@/ext/commerce-kit";
import { CartView } from "./CartView";
import { CheckoutView } from "./CheckoutView";
import {
  CHECKOUT_NOTICE_KEY,
  REFERRAL_MODE_KEY,
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

/**
 * 受管訂單那一邊(`commerce:orders` provider,id 是訂單表名)在結帳與付款之外多給的函式。
 * 商店不 import 它,只看有沒有這幾個函式;沒有就照舊。
 */
interface ManagedOrderHooks {
  /** 0.7.0:開不開放訪客結帳。 */
  guestCheckout?: () => Promise<boolean>;
  /** 0.8.0:回報匯款要填什麼(last5 / name / either / both)。 */
  transferReport?: () => Promise<unknown>;
}

async function managedOrderHooks(): Promise<ManagedOrderHooks | null> {
  const [{ getExtRuntime }, { buildProviderRegistry }] = await Promise.all([
    import("@/ext/loader"),
    import("@/ext/services"),
  ]);
  return buildProviderRegistry(await getExtRuntime()).getById<ManagedOrderHooks>(
    "commerce:orders",
    "ext_shop_orders",
  );
}

/** 0.7.0:有 `guestCheckout()` 且回 true 才算開放;沒有這個函式 = 不開放,和以前一樣要登入。 */
async function managedGuestCheckout(orders: ManagedOrderHooks | null): Promise<boolean> {
  return typeof orders?.guestCheckout === "function" && (await orders.guestCheckout()) === true;
}

/**
 * 0.8.0:回報匯款要填什麼,原始值交給 resolveCheckoutOptions 正規化。沒有這個函式或讀不出來 = undefined,
 * 結局頁照舊請客人到訂單頁回報;讀設定出錯也不擋結帳。
 */
async function managedTransferReport(orders: ManagedOrderHooks | null): Promise<unknown> {
  if (typeof orders?.transferReport !== "function") return undefined;
  try {
    return await orders.transferReport();
  } catch (error) {
    console.error("[shop] transferReport", error);
    return undefined;
  }
}

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
    referralMode,
    requireContact,
    checkoutNotice,
  ] = await Promise.all([
    getSetting<string>("ext.shop.cardProvider", ""),
    getSetting<string>("ext.shop.transferProvider", ""),
    getSetting<string>("ext.shop.shippingConfig", ""),
    // 優惠碼欄位只在店家真的建過碼時出現(空店不擺一個永遠沒用的輸入框)。
    listPromos({ db: db() }, "ext_shop_promos"),
    // 結帳頁開關;原始值交給 resolveCheckoutOptions 正規化(壞值退回預設)。
    getSetting<unknown>(REFERRAL_MODE_KEY, "field"),
    getSetting<unknown>(REQUIRE_CONTACT_KEY, false),
    getSetting<unknown>(CHECKOUT_NOTICE_KEY, ""),
  ]);
  // 運費設定與結帳 handler 走同一個 parse(壞設定 → 未啟用,不擋結帳)。
  const shippingConfig = parseShippingConfig(shippingRaw);
  const { getExtRuntime } = await import("@/ext/loader");
  const { getSessionUser } = await import("@/lib/auth");
  // 受管訂單:shop-operations 啟用即委派(commerce-kit 依 provider 判斷,shop 端
  // 沒有開關 —— 理由見 checkout-options.ts 檔頭與 README「商城營運模式」)。
  const managedOrders = !!(await getExtRuntime()).byId("shop-operations");
  const user = await getSessionUser();
  const orders = managedOrders ? await managedOrderHooks() : null;
  const [guestCheckout, transferReport] = await Promise.all([
    !user && managedGuestCheckout(orders),
    managedTransferReport(orders),
  ]);
  const options = resolveCheckoutOptions({
    managedOrders,
    signedIn: managedOrders && !!user,
    guestCheckout: managedOrders && guestCheckout === true,
    transferReport,
    referralMode,
    requireContact,
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
        contact={checkoutContact(user)}
      />
    </PageShell>
  );
}
