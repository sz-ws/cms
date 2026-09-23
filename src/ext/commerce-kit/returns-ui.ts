import type { MessageKey } from "@/lib/i18n";
import { refundCap, refundCapShipping, type RefundOrderAmounts, type ReturnEvent, type ReturnStatus, type ShopReturn } from "./returns";
import type { ReturnableOrder, ReturnStock } from "./returns-engine";
import type { OrderStatus } from "./types";

// 退貨後台(ReturnsWorkspace 與兩個 sheet)共用的樣式、型別與小工具。client 與 server
// 都能 import(沒有 D1 / server 相依)。樣式照 Paper & Ink(docs/admin-design-language.md),
// `admin:` 是站台後台主題的 token(core 1.47.0)。

export const cls = {
  field:
    "block h-10 w-full rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] border border-black/10 admin:border-ink/10 bg-white admin:bg-surface px-3 text-[14px] text-black/85 admin:text-ink/85 outline-none transition-[border-color,box-shadow] focus:border-black/30 admin:focus:border-ink/30 focus:shadow-[0_0_0_3px_rgba(0,0,0,0.05)] disabled:opacity-50",
  area:
    "block min-h-[4.5rem] w-full rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] border border-black/10 admin:border-ink/10 bg-white admin:bg-surface px-3 py-2 text-[14px] leading-relaxed text-black/85 admin:text-ink/85 outline-none transition-[border-color,box-shadow] focus:border-black/30 admin:focus:border-ink/30 focus:shadow-[0_0_0_3px_rgba(0,0,0,0.05)]",
  label: "flex flex-col gap-1.5 text-[13px] font-medium text-black/55 admin:text-ink/55",
  primary:
    "inline-flex h-9 items-center justify-center rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] bg-black admin:bg-ink px-3.5 text-[13px] font-medium text-white transition-[background-color,transform] duration-150 hover:bg-black/85 admin:hover:bg-ink/85 active:scale-[0.96] disabled:opacity-40 disabled:active:scale-100",
  quiet:
    "inline-flex h-9 items-center justify-center rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] bg-white admin:bg-surface px-3.5 text-[13px] font-medium text-black/70 admin:text-ink/70 shadow-[0_0_0_1px_rgba(0,0,0,0.08)] admin:shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.08))] transition-colors duration-150 hover:bg-black/[0.02] admin:hover:bg-ink/[0.02] disabled:opacity-40",
  notice:
    "rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] bg-black/[0.03] admin:bg-ink/[0.03] px-3 py-2 text-[13px] leading-relaxed text-black/70 admin:text-ink/70",
  alert:
    "rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] border border-red-600/15 bg-red-50 px-3 py-2 text-[13px] text-red-700",
  section: "flex flex-col gap-3 border-t border-black/[0.06] admin:border-ink/[0.06] pt-4",
  heading: "text-[12px] font-medium text-black/40 admin:text-ink/40",
  hint: "text-[12px] leading-relaxed text-black/45 admin:text-ink/45",
  // 明細:固定寬度的標籤欄 + 內容欄(不是左右兩端對齊)。
  dl: "grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-[13.5px]",
  dt: "text-black/45 admin:text-ink/45",
  dd: "min-w-0 text-black/85 admin:text-ink/85",
  mono: "font-mono text-[12.5px] text-black/85 admin:text-ink/85",
} as const;

export const money = (n: number) => `NT$ ${n.toLocaleString("zh-TW")}`;

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/** API 錯誤碼 → 字典訊息;不認得的碼用通用訊息。 */
export function errorMessage(t: Translate, code: string | undefined): string {
  const key = `returns.error.${code ?? "generic"}` as MessageKey;
  const text = t(key);
  return text === key ? t("returns.error.generic") : text;
}

export interface ReturnDetail {
  return: ShopReturn;
  events: ReturnEvent[];
  /** 訂單的金額(退款上限、上限裡的運費由它算)。 */
  order: (RefundOrderAmounts & { status: OrderStatus }) | null;
  stock: ReturnStock;
}

/** 退款金額欄下的上限提示;上限裡含運費時一併說出運費多少。 */
export function refundMaxHint(
  t: Translate,
  order: RefundOrderAmounts,
  items: readonly { unitPrice: number; qty: number }[],
): string {
  const amount = money(refundCap(order, items));
  const shipping = refundCapShipping(order, items);
  return shipping > 0
    ? t("returns.refund.maxWithShipping", { amount, shipping: money(shipping) })
    : t("returns.refund.max", { amount });
}

export interface OrderLookup {
  order: ReturnableOrder;
  stock: ReturnStock;
}

/** POST / GET 到退貨 API;失敗時丟出帶錯誤碼的 Error。 */
export async function callReturns<T>(url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, body === undefined
      ? { cache: "no-store" }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("network");
  }
  const data = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & T) | null;
  if (!res.ok || !data?.ok) throw new Error(data?.error ?? "generic");
  return data;
}

/** 一個狀態能做的下一步,依主要程度排序(第一個是預設選項)。 */
export interface ReturnAction {
  to: Exclude<ReturnStatus, "requested">;
  label: MessageKey;
  /** 送出後這筆退貨就結束。 */
  final?: boolean;
}

export const RETURN_ACTIONS: Record<ReturnStatus, ReturnAction[]> = {
  requested: [
    { to: "approved", label: "returns.action.approve" },
    { to: "rejected", label: "returns.action.reject", final: true },
    { to: "cancelled", label: "returns.action.cancel", final: true },
  ],
  approved: [
    { to: "received", label: "returns.action.receive" },
    { to: "refunded", label: "returns.action.refundDirect" },
    { to: "cancelled", label: "returns.action.cancel", final: true },
  ],
  received: [
    { to: "refunded", label: "returns.action.refund" },
    { to: "completed", label: "returns.action.closeNoRefund", final: true },
  ],
  refunded: [{ to: "completed", label: "returns.action.close", final: true }],
  rejected: [],
  completed: [],
  cancelled: [],
};

export function linesSummary(t: Translate, r: Pick<ShopReturn, "lines">): string {
  if (r.lines.length === 0) return "—";
  if (r.lines.length === 1) return `${r.lines[0].name} × ${r.lines[0].qty}`;
  return t("returns.itemsCount", { count: r.lines.length });
}
