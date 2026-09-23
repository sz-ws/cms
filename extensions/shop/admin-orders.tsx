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
import { hasRecordSearch, parseRecordSearch, recordSearchParams } from "@/ext/record-search";
import { AdminPageTitle } from "@/components/admin/admin-titles";

// 商店 adminPage:訂單一覽(狀態 filter pills + 動作)。積木全部來自
// @/ext/commerce-kit/admin,本檔只剩組裝。搜尋框在頂欄(index.ts 的 search 宣告),
// 這裡只讀網址上的條件。

const ORDERS_TABLE = "ext_shop_orders";

export async function ShopOrdersPage({
  searchParams,
}: {
  params: Record<string, string>;
  searchParams: Record<string, string>;
}) {
  const raw = searchParams.status ?? "";
  const status = isOrderStatus(raw) ? raw : undefined;
  const search = parseRecordSearch(new URLSearchParams(searchParams));
  const [orders, counts, transferProvider] = await Promise.all([
    loadOrders(ORDERS_TABLE, { status, limit: 100, search }),
    loadStatusCounts(ORDERS_TABLE),
    getSetting<string>("ext.shop.transferProvider", ""),
  ]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const searching = hasRecordSearch(search);
  // 狀態 pill 切換時保留搜尋條件(數字仍是全部訂單的各狀態筆數)。
  const withSearch = (next: string) => {
    const params = recordSearchParams(search);
    if (next) params.set("status", next);
    const query = params.toString();
    return query ? `/admin/ext/shop?${query}` : "/admin/ext/shop";
  };
  const awaiting = counts.awaiting_verify ?? 0;

  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-black/85">
            <AdminPageTitle fallback="訂單" />
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
          href={withSearch("")}
          className={`${PILL} ${!status ? PILL_AMBER : PILL_NEUTRAL}`}
        >
          全部 {total}
        </Link>
        {ORDER_STATUSES.map((s) => (
          <Link
            key={s}
            href={withSearch(s)}
            className={`${PILL} ${status === s ? PILL_AMBER : PILL_NEUTRAL}`}
          >
            {ORDER_STATUS_LABEL[s]} {counts[s] ?? 0}
          </Link>
        ))}
      </nav>

      <section className={CARD}>
        {searching ? (
          <p className="mb-3 text-[12.5px] text-black/45">
            符合搜尋條件 {orders.length} 筆{orders.length >= 100 ? "(只列最新 100 筆)" : ""}
          </p>
        ) : null}
        <CommerceOrdersTable
          orders={orders}
          actionsEndpoint="/api/ext/shop"
          transferProvider={transferProvider.trim() || undefined}
          returnsPage="/admin/ext/shop/returns"
        />
      </section>
    </div>
  );
}
