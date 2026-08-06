import Link from "next/link";
import { getSetting } from "@/lib/settings";
import {
  CARD,
  PILL,
  PILL_AMBER,
  PILL_NEUTRAL,
  ORDER_STATUS_LABEL,
  CommerceOrdersTable,
  loadOrders,
  loadStatusCounts,
} from "@/ext/commerce-kit/admin";
import { isOrderStatus, ORDER_STATUSES } from "@/ext/commerce-kit";

// 商店 adminPage:訂單一覽(狀態 filter pills + 動作)。積木全部來自
// @/ext/commerce-kit/admin,本檔只剩組裝。

const ORDERS_TABLE = "ext_shop_orders";

export async function ShopOrdersPage({
  searchParams,
}: {
  params: Record<string, string>;
  searchParams: Record<string, string>;
}) {
  const raw = searchParams.status ?? "";
  const status = isOrderStatus(raw) ? raw : undefined;
  const [orders, counts, transferProvider] = await Promise.all([
    loadOrders(ORDERS_TABLE, { status, limit: 100 }),
    loadStatusCounts(ORDERS_TABLE),
    getSetting<string>("ext.shop.transferProvider", ""),
  ]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const awaiting = counts.awaiting_verify ?? 0;

  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-black/85">
            訂單
          </h1>
          <p className="mt-1 text-[13.5px] leading-relaxed text-black/55">
            共 {total} 筆。付款由 payment provider 回寫;匯款訂單請至對帳佇列核可。
          </p>
        </div>
        <Link
          href="/admin/ext/shop/verify"
          className={`${PILL} ${awaiting > 0 ? PILL_AMBER : PILL_NEUTRAL}`}
        >
          待對帳 {awaiting}
        </Link>
      </header>

      {/* 狀態 filter pills(URL 即狀態)。 */}
      <nav className="flex flex-wrap gap-1.5" aria-label="訂單狀態篩選">
        <Link
          href="/admin/ext/shop"
          className={`${PILL} ${!status ? PILL_AMBER : PILL_NEUTRAL}`}
        >
          全部 {total}
        </Link>
        {ORDER_STATUSES.map((s) => (
          <Link
            key={s}
            href={`/admin/ext/shop?status=${s}`}
            className={`${PILL} ${status === s ? PILL_AMBER : PILL_NEUTRAL}`}
          >
            {ORDER_STATUS_LABEL[s]} {counts[s] ?? 0}
          </Link>
        ))}
      </nav>

      <section className={CARD}>
        <CommerceOrdersTable
          orders={orders}
          actionsEndpoint="/api/ext/shop"
          transferProvider={transferProvider.trim() || undefined}
        />
      </section>
    </div>
  );
}
