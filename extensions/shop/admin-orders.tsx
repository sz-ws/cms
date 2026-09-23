import Link from "next/link";
import { getSetting } from "@/lib/settings";
import { requireAuth } from "@/lib/auth";
import { canEditCurrentPage } from "@/lib/access-guards";
import { adminPageLevels } from "@/lib/access-api";
import {
  CARD,
  PILL,
  PILL_AMBER,
  PILL_NEUTRAL,
  ORDER_STATUS_LABEL,
  CommerceOrdersTable,
  loadFullyReturned,
  loadOrders,
  loadStatusCounts,
} from "@/ext/commerce-kit/admin";
import { isOrderStatus, ORDER_STATUSES } from "@/ext/commerce-kit";
import { hasRecordSearch, parseRecordSearch, recordSearchParams } from "@/ext/record-search";
import { AdminPageTitle } from "@/components/admin/admin-titles";
import { SHOP_RETURNS } from "./returns-config";

// 商店 adminPage:訂單一覽(狀態 filter pills + 動作)。積木全部來自
// @/ext/commerce-kit/admin,本檔只剩組裝。搜尋框在頂欄(index.ts 的 search 宣告),
// 這裡只讀網址上的條件。
// 角色與權限(core 1.50.0):只能看這一頁的角色沒有訂單動作;打不開對帳佇列的角色
// 看不到「待對帳」那顆連過去的 pill。「申請退貨」照商城營運訂單明細的兩條規則:只給能在
// 退貨管理建立退貨(那一頁的編輯)的人;商品都已經申請退貨的訂單改說一句,不給連結。

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
  const user = await requireAuth("admin");
  const [orders, counts, transferProvider, canEdit, levels] = await Promise.all([
    loadOrders(ORDERS_TABLE, { status, limit: 100, search }),
    loadStatusCounts(ORDERS_TABLE),
    getSetting<string>("ext.shop.transferProvider", ""),
    canEditCurrentPage(),
    adminPageLevels(user, { verify: "shop/verify", returns: "shop/returns" }),
  ]);
  const canCreateReturn = levels.returns === "edit";
  const returned = canCreateReturn ? await loadFullyReturned(SHOP_RETURNS, orders) : [];
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
            共 {total} 筆。刷卡付款會自動更新；匯款訂單請到對帳佇列核可。
          </p>
        </div>
        {levels.verify === "none" ? null : (
          <Link
            href="/admin/ext/shop/verify"
            className={`${PILL} ${awaiting > 0 ? PILL_AMBER : PILL_NEUTRAL}`}
          >
            待對帳 {awaiting}
          </Link>
        )}
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
            符合搜尋條件 {orders.length} 筆{orders.length >= 100 ? "（只列最新 100 筆）" : ""}
          </p>
        ) : null}
        <CommerceOrdersTable
          orders={orders}
          actionsEndpoint={canEdit ? "/api/ext/shop" : undefined}
          transferProvider={transferProvider.trim() || undefined}
          returnsPage={canCreateReturn ? "/admin/ext/shop/returns" : undefined}
          returned={returned}
        />
      </section>
    </div>
  );
}
