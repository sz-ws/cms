"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CoreTable, type CoreColumn } from "@/components/admin/core-table";
import { StatusBadge, useStatusSet } from "@/components/admin/StatusBadge";
import { useAdminPageTitle } from "@/components/admin/admin-titles";
import { useDateFormatter } from "@/components/DateTimeProvider";
import { useT } from "@/lib/i18n/I18nProvider";
import { RETURN_STATUSES, RETURN_STATUS_SET, type ReturnStatus, type ShopReturn } from "./returns";
import { cls, linesSummary, money } from "./returns-ui";
import { ReturnDetailSheet } from "./ReturnDetailSheet";
import { ReturnCreateSheet } from "./ReturnCreateSheet";

// 1.50.0:退貨管理(後台)。體例同訂單管理:狀態 pill 列 + CoreTable + 右側明細 sheet;
// 搜尋框在頂欄(extension 的 adminPages.search 宣告,core 畫),條件在網址。
// 列表由 server 頁載入(returns-admin.tsx),動作做完 router.refresh() 重抓。
//
// 網址參數:?status= 篩選;?open=<退貨編號> 打開那一筆(⌘K 的結果也走這個);
// ?order=<訂單編號> 打開「新增退貨」並帶好訂單(訂單頁的「申請退貨」)。

export interface ReturnsWorkspaceProps {
  rows: ShopReturn[];
  counts: Partial<Record<ReturnStatus, number>>;
  status: ReturnStatus | null;
  /** 目前的搜尋條件(q / from / to 的網址參數字串),切換篩選時保留。 */
  search: string;
  /** 表已建好(商店更新已套用)。 */
  ready: boolean;
  /** 列表最多載幾筆(到上限時提示用搜尋找較舊的)。 */
  limit: number;
  /** extension API base,如 "/api/ext/shop"。 */
  endpoint: string;
  /** 這一頁的網址,如 "/admin/ext/shop/returns"。 */
  pageHref: string;
  /** 訂單後台頁,如 "/admin/ext/shop"。 */
  ordersPage: string;
  /** 狀態組 `<extId>:returns`。 */
  statusRef: string;
  openNo: string | null;
  orderNo: string | null;
}

/** 「申請退貨」帶來的 ?order= 用過一次就拿掉:重新整理不會再打開一張已經處理過的新增表單。 */
function forgetOrderParam() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("order")) return;
  url.searchParams.delete("order");
  window.history.replaceState(window.history.state, "", url);
}

function useFilterHref(pageHref: string, search: string) {
  return (status: ReturnStatus | null) => {
    const params = new URLSearchParams(search);
    if (status) params.set("status", status);
    const query = params.toString();
    return query ? `${pageHref}?${query}` : pageHref;
  };
}

export function ReturnsWorkspace(props: ReturnsWorkspaceProps) {
  const { rows, counts, status, search, ready, limit, endpoint, pageHref, ordersPage, statusRef } = props;
  const t = useT();
  const router = useRouter();
  const dates = useDateFormatter();
  const statuses = useStatusSet(statusRef, RETURN_STATUS_SET);
  const title = useAdminPageTitle(t("returns.title"));
  const filterHref = useFilterHref(pageHref, search);

  const [openNo, setOpenNo] = useState<string | null>(props.openNo);
  const [linkedOpen, setLinkedOpen] = useState(props.openNo);
  if (props.openNo !== linkedOpen) {
    setLinkedOpen(props.openNo);
    if (props.openNo) setOpenNo(props.openNo);
  }
  // 新增退貨的 sheet:每次打開換一個 key,表單從頭開始;從訂單頁來的帶訂單編號。
  const [create, setCreate] = useState<{ open: boolean; orderNo: string | null; key: number }>({
    open: props.orderNo !== null,
    orderNo: props.orderNo,
    key: 0,
  });
  const [linkedOrder, setLinkedOrder] = useState(props.orderNo);
  if (props.orderNo !== linkedOrder) {
    setLinkedOrder(props.orderNo);
    if (props.orderNo) setCreate((prev) => ({ open: true, orderNo: props.orderNo, key: prev.key + 1 }));
  }
  const [notice, setNotice] = useState<string | null>(null);

  const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
  const searching = search !== "";

  const columns: CoreColumn<ShopReturn>[] = [
    { key: "no", label: t("returns.col.return"), render: (r) => <span className={cls.mono}>{r.returnNo}</span> },
    {
      key: "order",
      label: t("returns.col.order"),
      render: (r) => <span className="font-mono text-[12px] text-black/55 admin:text-ink/55">{r.orderNo}</span>,
    },
    {
      key: "customer",
      label: t("returns.col.customer"),
      render: (r) => (
        <span className="whitespace-nowrap text-[13px] text-black/85 admin:text-ink/85">
          {r.customerName}
          {r.customerPhone ? <span className="ml-2 text-[12px] tabular-nums text-black/45 admin:text-ink/45">{r.customerPhone}</span> : null}
        </span>
      ),
    },
    {
      key: "items",
      label: t("returns.col.items"),
      render: (r) => <span className="whitespace-nowrap text-[12.5px] text-black/55 admin:text-ink/55">{linesSummary(t, r)}</span>,
    },
    {
      key: "amount",
      label: t("returns.col.amount"),
      sortable: true,
      sortValue: (r) => r.requestedAmount,
      thClass: "text-right",
      tdClass: "text-right",
      render: (r) => <span className="text-[13px] tabular-nums text-black/85 admin:text-ink/85">{money(r.requestedAmount)}</span>,
    },
    {
      key: "status",
      label: t("returns.col.status"),
      sortable: true,
      sortValue: (r) => RETURN_STATUSES.indexOf(r.status),
      render: (r) => <StatusBadge set={statusRef} status={r.status} fallback={RETURN_STATUS_SET} />,
    },
    {
      key: "created",
      label: t("returns.col.created"),
      sortable: true,
      sortValue: (r) => r.createdAt,
      render: (r) => <span className="whitespace-nowrap text-[12.5px] tabular-nums text-black/55 admin:text-ink/55">{dates.dateTime(r.createdAt)}</span>,
    },
  ];

  const pill = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] transition-colors duration-150 ${
      active
        ? "bg-(--admin-accent)/10 font-medium text-(--admin-accent)"
        : "text-black/55 admin:text-ink/55 hover:bg-black/[0.04] admin:hover:bg-ink/[0.04] hover:text-black/80 admin:hover:text-ink/80"
    }`;

  return (
    <div className="flex max-w-6xl flex-col gap-4 text-black/85 admin:text-ink/85 antialiased">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-black/85 admin:text-ink/85">{title}</h1>
        <button
          type="button"
          disabled={!ready}
          onClick={() => setCreate((prev) => ({ open: true, orderNo: null, key: prev.key + 1 }))}
          className={cls.primary}
        >
          {t("returns.new")}
        </button>
      </header>

      {!ready ? (
        <p role="status" className={cls.notice}>
          {t("returns.notReady")}{" "}
          <Link href="/admin/extensions" className="underline underline-offset-4">{t("returns.notReadyLink")}</Link>
        </p>
      ) : null}
      {notice ? <p role="status" className={cls.notice}>{notice}</p> : null}

      <nav className="flex flex-wrap items-center gap-1" aria-label={t("returns.filterLabel")}>
        <Link href={filterHref(null)} aria-current={status === null ? "page" : undefined} className={pill(status === null)}>
          {t("returns.all")}
          <span className="tabular-nums text-black/35 admin:text-ink/35">{total}</span>
        </Link>
        {RETURN_STATUSES.map((s) => (
          <Link key={s} href={filterHref(s)} aria-current={status === s ? "page" : undefined} className={pill(status === s)}>
            {statuses[s]?.label ?? s}
            <span className="tabular-nums text-black/35 admin:text-ink/35">{counts[s] ?? 0}</span>
          </Link>
        ))}
      </nav>

      {searching || rows.length >= limit ? (
        <p className="text-[12.5px] tabular-nums text-black/40 admin:text-ink/40">
          {searching ? t("returns.searchCount", { count: rows.length }) : null}
          {searching && rows.length >= limit ? " · " : null}
          {rows.length >= limit ? t("returns.limited", { count: limit }) : null}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="rounded-[12px] admin:rounded-[calc(12px*var(--admin-radius-scale,1))] bg-black/[0.02] admin:bg-ink/[0.02] px-4 py-10 text-center text-[13px] text-black/40 admin:text-ink/40">
          {status || searching ? t("returns.emptyFiltered") : t("returns.empty")}
        </p>
      ) : (
        <CoreTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.returnNo}
          onRowClick={(r) => setOpenNo(r.returnNo)}
          rowActive={(r) => r.returnNo === openNo}
          trailingLabel={t("returns.open")}
          trailingActions={(r) => (
            <button
              type="button"
              onClick={() => setOpenNo(r.returnNo)}
              className="rounded-[6px] admin:rounded-[calc(6px*var(--admin-radius-scale,1))] px-2 py-1 text-[12px] font-medium text-black/60 admin:text-ink/60 transition-colors hover:bg-black/[0.05] admin:hover:bg-ink/[0.05] hover:text-black/85 admin:hover:text-ink/85"
            >
              {t("returns.open")}
            </button>
          )}
          minWidth={860}
        />
      )}

      <ReturnDetailSheet
        endpoint={endpoint}
        returnNo={openNo}
        statusRef={statusRef}
        ordersPage={ordersPage}
        onClose={() => setOpenNo(null)}
        onChanged={() => router.refresh()}
      />
      <ReturnCreateSheet
        key={create.key}
        endpoint={endpoint}
        open={create.open}
        initialOrderNo={create.orderNo}
        statusRef={statusRef}
        onClose={() => {
          forgetOrderParam();
          setCreate((prev) => ({ ...prev, open: false }));
        }}
        onOpenReturn={(no) => {
          forgetOrderParam();
          setCreate((prev) => ({ ...prev, open: false }));
          setOpenNo(no);
        }}
        onCreated={(created) => {
          forgetOrderParam();
          setCreate((prev) => ({ ...prev, open: false }));
          setNotice(t("returns.created", { no: created.returnNo }));
          setOpenNo(created.returnNo);
          router.refresh();
        }}
      />
    </div>
  );
}
