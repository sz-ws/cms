import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

// 「訂單編號 + 下單 Email」認人的額度(commerce-kit customer-order.ts),用真的計數表(login_attempts)跑:
//   - 只有猜錯才算:客人自己(帶對的 Email)查幾次都不用額度。
//   - 猜錯的次數照「訂單編號 + IP」記:別人拿一個訂單編號亂猜,鎖到的是他自己那個 IP,不是訂單的客人。
//   - 同一個訂單編號、所有 IP 合計另有一個比較鬆的上限,擋換很多 IP 分散著猜的。
//   - 不存在的訂單編號和別人的訂單:用掉的額度、被擋下的時機都一樣。

vi.mock("@/lib/cf", () => ({ getEnv: () => env, getDB: () => (env as { DB: unknown }).DB }));

import { db } from "../src/lib/db";
import { hitRateLimit, refundRateLimit } from "../src/lib/rate-limit";
import { ORDER_EMAIL_PROOF_LIMITS, resolveCustomerOrder, startOrderEmailProof } from "../src/ext/commerce-kit/customer-order";
import type { ApiCtx } from "../src/ext/types";
import type { CoreServices } from "../src/ext/services";

const d1 = () => (env as { DB: D1Database }).DB;
const ORDERS = "ext_proof_orders";
const EMAIL = "ming@example.com";
const OWNER_IP = "203.0.113.5";
const OTHER_IP = "198.51.100.9";
const { perClient, perOrder } = ORDER_EMAIL_PROOF_LIMITS;

const ctx = () => ({ services: { db: db() } as unknown as CoreServices }) as ApiCtx;
const from = (ip: string) => new Request("https://cms.test/api/ext/shop/returns/customer", { method: "POST", headers: { "cf-connecting-ip": ip } });
/** 一次認人:這個 IP 拿這個訂單編號與 Email 來問。回 ok / not_customer / rate_limited。 */
async function prove(orderNo: string, email: string, ip: string): Promise<string> {
  const answer = await resolveCustomerOrder(ctx(), ORDERS, { orderNo, email }, from(ip));
  return answer.ok ? "ok" : answer.reason;
}
const guesses = async (orderNo: string, ip: string, times: number) => {
  const answers: string[] = [];
  for (let i = 0; i < times; i++) answers.push(await prove(orderNo, `guess${i}@example.com`, ip));
  return answers;
};
/** 計數表裡這個訂單編號的兩個數:這個 IP 的、所有 IP 合計的。 */
async function counted(orderNo: string, ip: string) {
  const count = async (key: string) => (await d1().prepare("SELECT count FROM login_attempts WHERE key = ?").bind(key).first<{ count: number }>())?.count ?? 0;
  return { client: await count(`${perClient.namespace}:${ip}|${orderNo}`), order: await count(`${perOrder.namespace}:${orderNo}`) };
}

beforeAll(async () => {
  await d1().exec("CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);");
  await d1().exec(`CREATE TABLE IF NOT EXISTS ${ORDERS} (order_no TEXT PRIMARY KEY, status TEXT NOT NULL, lines TEXT NOT NULL, subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, shipping INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, payment_provider TEXT NOT NULL, customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, customer_phone TEXT, ship_address TEXT, region TEXT, shipping_method TEXT, promo_code TEXT, transfer_last5 TEXT, transfer_reported_at INTEGER, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, managed_by TEXT);`);
});
beforeEach(async () => {
  await d1().exec("DELETE FROM login_attempts;");
  await d1().exec(`DELETE FROM ${ORDERS};`);
  for (const orderNo of ["SOP1", "SOP2"]) {
    await d1().prepare(`INSERT INTO ${ORDERS} (order_no, status, lines, subtotal, total, payment_provider, customer_name, customer_email, created_at, updated_at) VALUES (?, 'shipped', '[]', 100, 100, 'banktransfer', '王小明', ?, 1, 2)`).bind(orderNo, EMAIL).run();
  }
});

describe("額度的大小", () => {
  it("is 10 wrong guesses per order number and address, and 60 per order number over all addresses, in 15 minutes", () => {
    expect(perClient).toMatchObject({ limit: 10, windowMs: 15 * 60_000 });
    expect(perOrder).toMatchObject({ limit: 60, windowMs: 15 * 60_000 });
    expect(perClient.namespace).not.toBe(perOrder.namespace);
  });
});

describe("只有猜錯才算", () => {
  it("lets the customer prove the order as often as they need, spending nothing", async () => {
    // 訪客打開訂單頁一次就認兩次(查單、能不能退貨):以前 15 分鐘看五次就被擋。
    for (let i = 0; i < 25; i++) expect(await prove("SOP1", EMAIL, OWNER_IP), `第 ${i + 1} 次`).toBe("ok");
    expect(await counted("SOP1", OWNER_IP)).toEqual({ client: 0, order: 0 });
    // Email 大小寫、前後空白不算猜錯。
    expect(await prove("SOP1", "  Ming@Example.COM ", OWNER_IP)).toBe("ok");
    expect(await counted("SOP1", OWNER_IP)).toEqual({ client: 0, order: 0 });
  });

  it("counts each wrong email once, for that address and for the order", async () => {
    expect(await guesses("SOP1", OTHER_IP, 3)).toEqual(["not_customer", "not_customer", "not_customer"]);
    expect(await counted("SOP1", OTHER_IP)).toEqual({ client: 3, order: 3 });
    // 中間認對一次不會把猜錯的洗掉,也不多算。
    expect(await prove("SOP1", EMAIL, OTHER_IP)).toBe("ok");
    expect(await counted("SOP1", OTHER_IP)).toEqual({ client: 3, order: 3 });
    // 別的訂單編號是另一份。
    expect(await counted("SOP2", OTHER_IP)).toEqual({ client: 0, order: 0 });
  });
});

describe("別人拿訂單編號亂猜", () => {
  it("locks out the address that keeps guessing, and never the customer", async () => {
    expect(await guesses("SOP1", OTHER_IP, 10)).toEqual(Array.from({ length: 10 }, () => "not_customer"));
    // 第 11 次起這個 IP 對這張訂單一律被擋,帶對的 Email 也一樣(不讓他知道猜對了沒)。
    expect(await prove("SOP1", "guess-again@example.com", OTHER_IP)).toBe("rate_limited");
    expect(await prove("SOP1", EMAIL, OTHER_IP)).toBe("rate_limited");
    // 訂單的客人在自己的 IP 照常。
    expect(await prove("SOP1", EMAIL, OWNER_IP)).toBe("ok");
    // 他繼續敲 100 次:都被擋,而且被擋下來的不算進「所有 IP 合計」—— 一個 IP 敲不滿那個上限,客人還是照常。
    expect(new Set(await guesses("SOP1", OTHER_IP, 100))).toEqual(new Set(["rate_limited"]));
    expect((await counted("SOP1", OTHER_IP)).order).toBe(10);
    for (let i = 0; i < 5; i++) expect(await prove("SOP1", EMAIL, OWNER_IP)).toBe("ok");
    // 這個 IP 查別張訂單不受影響。
    expect(await prove("SOP2", EMAIL, OTHER_IP)).toBe("ok");
  });

  it("treats an order number that does not exist exactly like someone else's order", async () => {
    const real = await guesses("SOP1", OTHER_IP, 12);
    const none = await guesses("NOSUCH1", OTHER_IP, 12);
    expect(none).toEqual(real);
    expect(real.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => "not_customer"));
    expect(real.slice(10)).toEqual(["rate_limited", "rate_limited"]);
    expect(await counted("NOSUCH1", OTHER_IP)).toEqual(await counted("SOP1", OTHER_IP));
  });

  it("stops a guess spread over many addresses at the per-order ceiling, for that order only", async () => {
    for (let n = 1; n <= 6; n++) expect(await guesses("SOP1", `192.0.2.${n}`, 10), `IP ${n}`).toEqual(Array.from({ length: 10 }, () => "not_customer"));
    expect((await counted("SOP1", "192.0.2.6")).order).toBe(60);
    // 第 61 次猜:換一個新的 IP 也被擋。這一道擋下來時,客人自己也要等(最後一道防線)。
    expect(await prove("SOP1", "guess@example.com", "192.0.2.7")).toBe("rate_limited");
    expect(await prove("SOP1", EMAIL, OWNER_IP)).toBe("rate_limited");
    // 另一張訂單照常。
    expect(await prove("SOP2", EMAIL, OWNER_IP)).toBe("ok");
  });
});

describe("插件自己的查單用同一份額度(startOrderEmailProof)", () => {
  it("spends on a wrong guess, gives the attempt back when the plugin says it was not one, and shares the count with core", async () => {
    const wrong = await startOrderEmailProof("SOP1", from(OTHER_IP));
    expect(wrong.allowed).toBe(true);
    expect(await counted("SOP1", OTHER_IP)).toEqual({ client: 1, order: 1 });
    const right = await startOrderEmailProof("SOP1", from(OTHER_IP));
    await right.release();
    expect(await counted("SOP1", OTHER_IP)).toEqual({ client: 1, order: 1 });
    // 和 core 的認人合計:這個 IP 在插件那邊猜錯 1 次,在這裡再猜錯 9 次就滿了。
    expect(await guesses("SOP1", OTHER_IP, 10)).toEqual([...Array.from({ length: 9 }, () => "not_customer"), "rate_limited"]);
    const blocked = await startOrderEmailProof("SOP1", from(OTHER_IP));
    expect(blocked.allowed).toBe(false);
    // 被擋下來的沒有東西可以還。
    await blocked.release();
    expect((await counted("SOP1", OTHER_IP)).order).toBe(10);
  });

  it("uses the same key for a request with no client address header as other routes do", async () => {
    const attempt = await startOrderEmailProof("SOP1", new Request("https://cms.test/x", { method: "POST" }));
    expect(attempt.allowed).toBe(true);
    expect(await counted("SOP1", "local")).toEqual({ client: 1, order: 1 });
  });
});

describe("把記過的一次還回去(refundRateLimit)", () => {
  const limit = { namespace: "refund-test", limit: 2, windowMs: 60_000 };
  it("takes one hit back and never goes below zero", async () => {
    expect(await hitRateLimit("a", limit)).toBe(false);
    expect(await hitRateLimit("a", limit)).toBe(false);
    await refundRateLimit("a", limit);
    // 還了一次:再記一次還在上限內,再下一次才超過。
    expect(await hitRateLimit("a", limit)).toBe(false);
    expect(await hitRateLimit("a", limit)).toBe(true);
    for (let i = 0; i < 5; i++) await refundRateLimit("a", limit);
    await refundRateLimit("never-hit", limit);
    expect(await hitRateLimit("a", limit)).toBe(false);
    expect(await hitRateLimit("never-hit", limit)).toBe(false);
    // 別的 key 不受影響。
    expect(await hitRateLimit("b", limit)).toBe(false);
  });
});
