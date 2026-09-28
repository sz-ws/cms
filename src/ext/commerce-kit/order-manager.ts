import { sql } from "drizzle-orm";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import { sitePath } from "@/lib/sign-in-continue";
import { TABLE_RE } from "../payment-kit/settle";
import type { ApiCtx, Extension } from "../types";
import type { ProviderRegistry } from "../providers";
import type { CommerceDb, TransitionExtras } from "./orders";
import type { OrderStatus } from "./types";
import { legacyManagedOrder, legacyManagedTable } from "./legacy-ownership";
import { legacyStorefront } from "./legacy-storefront";

// commerce-kit 1.63.0:訂單管理插件(OrderManager)的合約。
//
// 一個插件可以接手某張訂單表的結帳與訂單處理:以 capability "commerce:orders" 註冊 provider,
// provider id = 訂單表名(例:"ext_shop_orders")。它自己建的訂單在訂單列的 managed_by 欄寫上自己的
// extension id(shop migration 0007)。core 依這一欄決定一筆訂單歸誰:
//
//   managed_by 有值、插件啟用中  → 轉移與匯款回報交給它;商店自己的核帳 API 回 409 order_managed。
//   managed_by 有值、插件停用了  → 409 order_managed,後台說「這筆訂單由「{插件名稱}」處理,請先啟用它」
//                                  (名稱讀那個插件的 manifest)。
//   結帳時沒有插件接手,但有它管過的訂單 → 503 checkout_paused(寧可停,不讓訂單分兩邊)。
//   managed_by 是空的             → core 自己處理。
//
// 1.63.0 以前的舊站沒有 managed_by:legacy-ownership.ts 照舊看 `<訂單表>_managed` 表,2.0 拿掉。

export const ORDERS_CAPABILITY = "commerce:orders";

/** 商店結帳頁要照著畫的事。 */
export interface OrderStorefront {
  /** required = 要登入才能結帳;optional = 訪客也能結帳。 */
  signIn: "required" | "optional";
  /** 電話與收件地址必填。 */
  requireContact: boolean;
  /** 客人看自己訂單(或用訂單編號查單)的站內頁面;null = 沒有。 */
  ordersHref: string | null;
}

/** core 的匯款回報 API 收到、轉給接手的插件的內容(還沒檢查格式)。 */
export interface TransferReportInput {
  orderNo: string;
  reference?: string;
  payerName?: string;
  /** 訪客:下單的 Email(查單的憑證)。已登入的會員不帶。 */
  email?: string;
}

export interface OrderManager {
  /** 整筆結帳(商店的 POST checkout 交給它)。 */
  checkout(req: Request, ctx: ApiCtx): Promise<Response>;
  /** 狀態轉移(付款結算、後台與 AI 的動作)。回 true = 轉了。 */
  transition(orderNo: string, to: OrderStatus, extras: TransitionExtras): Promise<boolean>;
  /** 結帳頁要照著畫的事;沒有 = 要登入、電話地址必填、沒有訂單頁。 */
  storefront?(): Promise<OrderStorefront>;
  /** 匯款回報:core 的 POST transfer-report 把它的訂單轉過來;插件自己看登入的人或訪客的 Email。 */
  reportTransfer?(input: TransferReportInput, req: Request, ctx: ApiCtx): Promise<Response>;
}

/** 一筆訂單歸誰。 */
export type OrderOwner =
  | { kind: "core" }
  | { kind: "managed"; manager: OrderManager }
  | { kind: "unavailable"; name: string | null };

/** 接手的插件沒啟用時,core 不碰它的訂單。 */
export class OrderManagedError extends Error {
  constructor(public readonly managerName: string | null) {
    super(unavailableMessage(managerName));
  }
}

function unavailableMessage(name: string | null): string {
  return name ? `這筆訂單由「${name}」處理，請先啟用它。` : "這筆訂單由其他插件處理，請先啟用它。";
}

/** 409 order_managed:插件停用了(unavailable),或這個動作要到插件那邊做(managed)。 */
export function orderManagedResponse(owner: Exclude<OrderOwner, { kind: "core" }>, handledHere = false): Response {
  const message =
    owner.kind === "unavailable"
      ? unavailableMessage(owner.name)
      : handledHere
        ? "這筆訂單不能在這裡處理。"
        : "這筆訂單由接手訂單的插件處理，請到它的頁面操作。";
  return Response.json({ ok: false, error: "order_managed", message }, { status: 409 });
}

/**
 * 公開路由(客人回報匯款)用的 409 order_managed:同一個代碼,但不寫接手的插件是誰、也不叫客人去啟用它。
 */
export function customerOrderManagedResponse(): Response {
  return Response.json(
    { ok: false, error: "order_managed", message: "這筆訂單目前無法回報匯款，請聯絡店家。" },
    { status: 409 },
  );
}

/** 503 checkout_paused:有插件接手過的訂單,但那個插件現在沒啟用。 */
export function checkoutPausedResponse(): Response {
  return Response.json(
    { ok: false, error: "checkout_paused", message: "目前暫停結帳，請稍後再試。" },
    { status: 503 },
  );
}

/** 表名在拼進 SQL(sql.raw)之前先驗(同 orders.ts、payment-kit settle.ts)。 */
function assertTable(table: string): void {
  if (!TABLE_RE.test(table)) throw new Error(`[commerce-kit] invalid orders table name "${table}"`);
}

function isMissingColumn(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
  return /no such column/i.test(text);
}

/** 有沒有插件接手過的訂單(managed_by 有值,索引查一筆;舊站看標記表)。 */
export async function hasManagedOrders(deps: CommerceDb, table: string): Promise<boolean> {
  assertTable(table);
  try {
    const row = await deps.db.get(sql`SELECT 1 AS one FROM ${sql.raw(table)} WHERE managed_by IS NOT NULL LIMIT 1`);
    if (row) return true;
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
  }
  return legacyManagedTable(deps, table);
}

interface Runtime {
  enabled: readonly Extension[];
  all: readonly Extension[];
  byId: (id: string) => Extension | undefined;
}

async function runtime(): Promise<{ rt: Runtime; providers: Pick<ProviderRegistry, "getById"> }> {
  // 動態 import:commerce-kit 被 extension 在 module 載入時 import,靜態引 loader 會形成循環。
  const [{ getExtRuntime }, { buildProviderRegistry }] = await Promise.all([
    import("../loader"),
    import("../services"),
  ]);
  const rt = await getExtRuntime();
  return { rt, providers: buildProviderRegistry(rt) };
}

const providesTable = (ext: Extension, table: string) =>
  (ext.provides ?? []).some((p) => p.capability === ORDERS_CAPABILITY && p.id === table);

function nameOf(ext: Extension | undefined): string | null {
  return ext ? (resolveLocalizedString(ext.name, "zh-Hant") ?? ext.id) : null;
}

/**
 * 這筆訂單歸誰。查不到這筆訂單 = core(呼叫端自己回 not_found)。managed_by 指的插件要啟用、而且
 * 為這張表提供 commerce:orders,才交給它;否則 unavailable。
 */
export async function resolveOrderOwner(deps: CommerceDb, table: string, orderNo: string): Promise<OrderOwner> {
  assertTable(table);
  const row = await deps.db.get<{ managed_by?: string | null }>(
    sql`SELECT * FROM ${sql.raw(table)} WHERE order_no = ${orderNo}`,
  );
  if (!row) return { kind: "core" };
  const managedBy = typeof row.managed_by === "string" && row.managed_by ? row.managed_by : null;
  if (!managedBy && !(await legacyManagedOrder(deps, table, orderNo))) return { kind: "core" };
  const { rt, providers } = await runtime();
  const owner = managedBy
    ? rt.byId(managedBy)
    : rt.enabled.find((ext) => providesTable(ext, table));
  const manager = owner && providesTable(owner, table)
    ? providers.getById<OrderManager>(ORDERS_CAPABILITY, table)
    : null;
  if (manager) return { kind: "managed", manager };
  const known = managedBy
    ? rt.all.find((ext) => ext.id === managedBy)
    : rt.all.find((ext) => providesTable(ext, table));
  return { kind: "unavailable", name: nameOf(known) };
}

const SIGN_IN = ["required", "optional"] as const;

/**
 * 結帳頁要照著畫的事:插件的 storefront(),值不對的部分換成保守的預設;沒有 storefront() 走舊的 guestCheckout()。
 * ordersHref 只收同站路徑(sitePath:單一 "/" 開頭,沒有 "//"、反斜線與控制字元)。
 */
export async function storefrontOf(manager: OrderManager): Promise<OrderStorefront> {
  if (typeof manager.storefront !== "function") return legacyStorefront(manager);
  const raw = (await manager.storefront()) as Partial<OrderStorefront> | null;
  const href = raw?.ordersHref;
  return {
    signIn: SIGN_IN.find((value) => value === raw?.signIn) ?? "required",
    requireContact: raw?.requireContact !== false,
    ordersHref: typeof href === "string" ? sitePath(href) : null,
  };
}
