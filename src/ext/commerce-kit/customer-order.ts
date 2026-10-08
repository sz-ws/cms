import { hitRateLimit, refundRateLimit } from "@/lib/rate-limit";
import { timingSafeEqualString } from "@/lib/security";
import type { ApiCtx } from "../types";
import { resolveOrderOwner, type CustomerOrderAnswer, type CustomerOrderInput } from "./order-manager";
import { getOrder } from "./orders";
import type { OrderStatus } from "./types";

// commerce-kit:這個人是不是這張訂單的客人。公開路由讓客人自己對訂單做事(申請退貨)之前先問這裡。
//
//   訂單管理插件的訂單(managed_by) → 問它的 customerOrder():會員、訪客怎麼認,照它自己的訂單頁。
//                                      它沒有這個函式、或它停用了 → 不是(core 不替別人的訂單認人)。
//   商店自己的訂單                  → 訂單編號 + 下單的 Email(和回報匯款同一種憑證)。訂單上沒有記會員,
//                                      所以不看登入的人:帳號的 Email 不一定驗證過,不能當憑證。
//
// 不是他的、找不到、Email 不對,一律同一個答案:不讓人拿訂單編號試出誰下了單、或這個編號存不存在。
// 限速也一樣不能看得出來:帶 Email 的在查任何東西之前先記一次(startOrderEmailProof),不管這個編號存不存在、歸誰。
// 所以插件的 customerOrder() 裡不要再照訂單編號或 IP 限速 —— 只有它的訂單才會記到,額度有沒有被用掉就成了
// 「這個編號是不是它的訂單」的線索。

const QUARTER = 15 * 60_000;

/**
 * 用「訂單編號 + 下單 Email」認人的額度。只有猜錯才算(認對了把這一次還回去):
 *   perClient:同一個訂單編號、同一個 IP,15 分鐘猜錯 10 次(知道編號的人也猜不了 Email)。照 IP 分開記,所以別人
 *              拿一個訂單編號亂猜,鎖到的是他自己,不是訂單的客人;客人自己帶對的 Email,查幾次都不用額度。
 *   perOrder :同一個訂單編號、所有 IP 合計,15 分鐘猜錯 60 次。擋換很多 IP 分散著猜的;這一道擋下來時客人自己
 *              也要等,所以放得鬆。被 perClient 擋下來的不算進這裡:一個 IP 再怎麼敲,最多占 10 次。
 * 接手訂單的插件自己的查單也用這一份(startOrderEmailProof),兩邊合計,不會因為多了一條路就多了猜的次數。
 */
export const ORDER_EMAIL_PROOF_LIMITS = {
  perClient: { namespace: "commerce-order-email-proof-client", limit: 10, windowMs: QUARTER },
  perOrder: { namespace: "commerce-order-email-proof", limit: 60, windowMs: QUARTER },
} as const;

/** 一次用「訂單編號 + Email」認人的嘗試。 */
export interface OrderEmailProofAttempt {
  /** false = 額度用完了:什麼都不要查,回 429。 */
  allowed: boolean;
  /** 這一次不是猜錯(認到人了):把它還回去。沒呼叫 = 算猜錯一次。被擋下來的嘗試呼叫了也沒有事。 */
  release(): Promise<void>;
}

const BLOCKED: OrderEmailProofAttempt = { allowed: false, release: async () => {} };

/**
 * 開始一次認人:在查任何東西之前先把這一次記上(同時來的很多次嘗試也超不過上限),認到人再 release()。
 * 對每個訂單編號都一樣 —— 存不存在、歸誰都先記,所以從額度看不出一個編號是不是真的訂單。
 * IP 和別的公開路由同一個來源(cf-connecting-ip;本機沒有這個 header 時是 "local")。
 * key 是「IP|訂單編號」:IP 裡不會有 "|",訂單編號裡有也不會和別的組合撞在一起。
 */
export async function startOrderEmailProof(orderNo: string, req: Request): Promise<OrderEmailProofAttempt> {
  const { perClient, perOrder } = ORDER_EMAIL_PROOF_LIMITS;
  const client = `${req.headers.get("cf-connecting-ip") ?? "local"}|${orderNo}`;
  if (await hitRateLimit(client, perClient)) return BLOCKED;
  if (await hitRateLimit(orderNo, perOrder)) {
    // 被合計那一道擋下來的沒有猜到任何東西:自己那一筆還回去,等合計那一道過了,他不會還被自己的額度擋著。
    await refundRateLimit(client, perClient);
    return BLOCKED;
  }
  return {
    allowed: true,
    release: async () => {
      await Promise.all([refundRateLimit(client, perClient), refundRateLimit(orderNo, perOrder)]);
    },
  };
}

/** resolveCustomerOrder 的答案。rate_limited 是在查任何東西之前決定的,對每個訂單編號都一樣。 */
export type CustomerOrderProof =
  | { ok: true; memberId: string | null; shippedAt: number | null }
  | { ok: false; reason: "not_customer" | "rate_limited" };

const NOT_CUSTOMER = { ok: false, reason: "not_customer" } as const;
/** 貨已經出去的訂單狀態。 */
const SHIPPED: readonly OrderStatus[] = ["shipped", "completed"];

const sameEmail = (stored: string, given: string) =>
  // 固定時間比對;存的是空的(或沒有這張訂單)也比一次,換成一個不可能是 Email 的字,每種失敗走同一條路。
  timingSafeEqualString(stored.trim().toLowerCase() || "\u0000", given.trim().toLowerCase());

/** 插件的回答照合約收;不像樣的(少了欄位、型別不對)當作不是。 */
function checked(answer: CustomerOrderAnswer | null | undefined): CustomerOrderProof {
  if (answer === null || typeof answer !== "object") return NOT_CUSTOMER;
  const raw = answer as { ok?: unknown; memberId?: unknown; shippedAt?: unknown };
  const memberOk = raw.memberId === null || typeof raw.memberId === "string";
  const shippedOk = raw.shippedAt === null || (typeof raw.shippedAt === "number" && Number.isFinite(raw.shippedAt));
  if (raw.ok !== true || !memberOk || !shippedOk) return NOT_CUSTOMER;
  return { ok: true, memberId: raw.memberId as string | null, shippedAt: raw.shippedAt as number | null };
}

/**
 * 商店自己的訂單。出貨時間:訂單表沒有另外記,用訂單最後一次異動的時間 —— 已出貨的訂單就是出貨那一刻,
 * 已完成的是標記完成那一刻(比出貨晚,期限對客人寬一點)。還沒出貨是 null。
 */
async function ownOrder(ctx: ApiCtx, table: string, input: CustomerOrderInput): Promise<CustomerOrderProof> {
  const order = await getOrder(ctx.services, table, input.orderNo);
  const matches = sameEmail(order?.customerEmail ?? "", input.email ?? "");
  if (!order || input.email === undefined || !matches) return NOT_CUSTOMER;
  return { ok: true, memberId: null, shippedAt: SHIPPED.includes(order.status) ? order.updatedAt : null };
}

/** 這張訂單歸誰就問誰(不管額度)。 */
async function proveCustomer(ctx: ApiCtx, table: string, input: CustomerOrderInput, req: Request): Promise<CustomerOrderProof> {
  const owner = await resolveOrderOwner(ctx.services, table, input.orderNo);
  if (owner.kind === "core") return ownOrder(ctx, table, input);
  if (owner.kind !== "managed" || typeof owner.manager.customerOrder !== "function") return NOT_CUSTOMER;
  return checked(await owner.manager.customerOrder(input, req, ctx));
}

/**
 * 呼叫的人是不是這張訂單的客人。呼叫端(公開路由)自己先照 IP 限速;用 Email 認人的額度在這裡記
 * (startOrderEmailProof):認到人就還回去,沒認到(或中途出錯,說不出認到了沒)算猜錯一次。
 * not_customer 一律回客人同一個 404,rate_limited 回 429。
 */
export async function resolveCustomerOrder(
  ctx: ApiCtx,
  table: string,
  input: CustomerOrderInput,
  req: Request,
): Promise<CustomerOrderProof> {
  const attempt = input.email === undefined ? null : await startOrderEmailProof(input.orderNo, req);
  if (attempt && !attempt.allowed) return { ok: false, reason: "rate_limited" };
  const proof = await proveCustomer(ctx, table, input, req);
  if (proof.ok && attempt) await attempt.release();
  return proof;
}
