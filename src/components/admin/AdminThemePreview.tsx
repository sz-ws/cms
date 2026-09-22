"use client";

import type { CSSProperties } from "react";
import { Plus } from "lucide-react";
import { useLocale } from "@/lib/i18n/I18nProvider";
import { Input } from "@/components/ui/legacy";
import {
  Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import type { AdminIconSet } from "@/lib/admin-theme";
import { CoreTable } from "./core-table";
import { AdminIconSetProvider } from "./admin-icon-set";
import { AdminTokenIcon } from "./adminNavIcons";
import { SAVE_BAR_SECONDARY_CLASS, SAVE_BUTTON_CLASS } from "./SaveBar";
import { cn } from "@/lib/utils";

// 風格編輯器右邊的預覽:一張縮小的「訂單」頁。輸入框、按鈕、表格、對話框都用後台
// 真正在用的元件與 class,預覽長什麼樣,存了之後各頁就長什麼樣。

const copy = {
  en: {
    workspace: "Workspace", overview: "Overview", orders: "Orders", settings: "Settings",
    ordersNote: "2 awaiting shipment", newOrder: "New order", search: "Search orders",
    order: "Order", customer: "Customer", status: "Status", paid: "Paid", toShip: "To ship",
    customerName: "Customer name", create: "Create", cancel: "Cancel",
    rows: [["#1024", "Alex Chen", "toShip"], ["#1023", "Mia Wong", "paid"], ["#1022", "Leo Lin", "toShip"]],
  },
  "zh-Hant": {
    workspace: "工作區", overview: "總覽", orders: "訂單", settings: "設定",
    ordersNote: "2 筆待出貨", newOrder: "新增訂單", search: "搜尋訂單",
    order: "訂單", customer: "客戶", status: "狀態", paid: "已付款", toShip: "待出貨",
    customerName: "客戶姓名", create: "建立", cancel: "取消",
    rows: [["#1024", "王小明", "toShip"], ["#1023", "陳怡君", "paid"], ["#1022", "林志豪", "toShip"]],
  },
} as const;

const CARD_SHADOW =
  "shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04))]";
const FIELD =
  "h-9 rounded-[calc(10px*var(--admin-radius-scale,1))] border-ink/10 bg-surface text-[13px] text-ink/85 placeholder:text-ink/30";

export function AdminThemePreview({
  mode,
  style,
  icons,
}: {
  /** default = 紙與墨(套回原本的 token),custom = 其他(admin-theme.css)。 */
  mode: "default" | "custom";
  /** 草稿的主題變數與字體。 */
  style: CSSProperties;
  /** 草稿的側欄圖示組。 */
  icons: AdminIconSet;
}) {
  const locale = useLocale();
  const c = copy[locale];
  type Row = { id: string; customer: string; status: "paid" | "toShip" };
  const rows: Row[] = c.rows.map(([id, customer, status]) => ({ id, customer, status }));

  return (
    <AdminIconSetProvider value={icons}>
      <div data-admin-theme-preview={mode} style={style} className="overflow-hidden rounded-[16px] border border-border">
        {/* 窄螢幕沒有側欄,不需要撐高。 */}
        <div className="flex sm:min-h-[400px]">
          <aside aria-hidden className="hidden w-32 shrink-0 border-r border-border p-2.5 sm:block">
            <p className="px-2 pt-1 pb-1.5 text-[11px] text-ink/35">{c.workspace}</p>
            {([[c.overview, "dashboard"], [c.orders, "shopping-bag"], [c.settings, "settings"]] as const).map(([title, token], i) => (
              <div
                key={title}
                className={cn(
                  "mt-0.5 flex items-center gap-2 rounded-[calc(8px*var(--admin-radius-scale,1))] px-2 py-2 text-[12px]",
                  i === 1 ? cn("bg-surface font-medium text-ink/90", CARD_SHADOW) : "text-ink/55",
                )}
              >
                <AdminTokenIcon token={token} className={cn("size-3.5 shrink-0", i === 1 && "text-(--admin-accent)")} />
                {title}
              </div>
            ))}
          </aside>
          <div className="min-w-0 flex-1 p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[17px] font-semibold tracking-[-0.01em] text-ink/90">{c.orders}</p>
                <p className="mt-1 text-[12px] text-ink/40">{c.ordersNote}</p>
              </div>
              <Dialog>
                <DialogTrigger render={<button type="button" className={cn(SAVE_BUTTON_CLASS, "h-9 text-[13px]")} />}>
                  <Plus aria-hidden className="size-4" />
                  {c.newOrder}
                </DialogTrigger>
                <DialogContent data-admin-theme-preview={mode} style={style}>
                  <DialogHeader>
                    <DialogTitle>{c.newOrder}</DialogTitle>
                  </DialogHeader>
                  <label className="grid gap-1.5 text-[13px] font-medium text-ink/55">
                    {c.customerName}
                    <Input className={FIELD} />
                  </label>
                  <DialogFooter>
                    <DialogClose render={<button type="button" className={SAVE_BAR_SECONDARY_CLASS} />}>{c.cancel}</DialogClose>
                    <DialogClose render={<button type="button" className={SAVE_BUTTON_CLASS} />}>{c.create}</DialogClose>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
            <Input aria-label={c.search} placeholder={c.search} className={cn(FIELD, "mt-4 mb-3")} />
            <CoreTable
              minWidth={0}
              columns={[
                { key: "id", label: c.order, render: (row: Row) => <span className="text-[12px] tabular-nums text-ink/85">{row.id}</span> },
                { key: "customer", label: c.customer, render: (row: Row) => <span className="text-[12px] text-ink/70">{row.customer}</span> },
                {
                  key: "status",
                  label: c.status,
                  render: (row: Row) => (
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[11px] font-medium",
                        row.status === "paid" ? "bg-(--admin-accent)/10 text-(--admin-accent)" : "bg-ink/[0.05] text-ink/55",
                      )}
                    >
                      {c[row.status]}
                    </span>
                  ),
                },
              ]}
              rows={rows}
              rowKey={(row) => row.id}
            />
          </div>
        </div>
      </div>
    </AdminIconSetProvider>
  );
}
