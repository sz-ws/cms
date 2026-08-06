import Link from "next/link";
import { getSetting } from "@/lib/settings";
import { db } from "@/lib/db";
import { listPromos, parseShippingConfig } from "@/ext/commerce-kit";
import { CartView } from "./CartView";
import { CheckoutView } from "./CheckoutView";

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

export function ShopCartPage() {
  return (
    <PageShell title="購物車">
      <CartView />
    </PageShell>
  );
}

export async function ShopCheckoutPage() {
  const [cardProvider, transferProvider, shippingRaw, promos] = await Promise.all([
    getSetting<string>("ext.shop.cardProvider", ""),
    getSetting<string>("ext.shop.transferProvider", ""),
    getSetting<string>("ext.shop.shippingConfig", ""),
    // 優惠碼欄位只在店家真的建過碼時出現(空店不擺一個永遠沒用的輸入框)。
    listPromos({ db: db() }, "ext_shop_promos"),
  ]);
  // 運費設定與結帳 handler 走同一個 parse(壞設定 → 未啟用,不擋結帳)。
  const shippingConfig = parseShippingConfig(shippingRaw);
  return (
    <PageShell title="結帳" backHref="/shop/cart" backLabel="回購物車">
      <CheckoutView
        cardEnabled={Boolean(cardProvider.trim())}
        transferEnabled={Boolean(transferProvider.trim())}
        shippingConfig={shippingConfig}
        promoEnabled={promos.some((p) => p.enabled)}
      />
    </PageShell>
  );
}
