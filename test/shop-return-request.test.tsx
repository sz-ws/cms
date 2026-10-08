import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 商店:客人在自己的訂單上申請退貨。設定(出貨後幾天)、送什麼到哪裡(return-request.ts,沒有 React),
// 以及畫面(ReturnRequest.tsx,伺服器端渲染)。測的是出現什麼、沒有什麼(金額),不是樣式。
// 伺服器的規則在 commerce-returns-customer.test.ts。

import { CUSTOMER_RETURN_DAYS_KEY, SHOP_RETURN_SETTINGS } from "../extensions/shop/returns-config";
import {
  CUSTOMER_REASON_LABELS,
  CUSTOMER_RETURN_LABELS,
  RETURN_REQUEST_URL,
  callReturnRequest,
  defaultReturnQty,
  explainReturnRequestError,
  isStaleReturnError,
  pickedLines,
  returnRequestBody,
  showsReturnRequest,
} from "../extensions/shop/return-request";
import { RETURN_ASKED, ReturnRequest, ReturnRequestView, type ReturnRequestViewProps } from "../extensions/shop/ReturnRequest";
import { RETURN_REASONS, RETURN_STATUSES, customerReturnDays, type CustomerReturnView } from "../src/ext/commerce-kit/returns";
import { validateSettingValue } from "../src/lib/setting-validation";

const DEADLINE = Date.UTC(2026, 9, 15, 6, 5);
const LINES = [
  { productId: "p1", name: "測試商品", returnable: 2 },
  { productId: "p2", name: "另一項商品", returnable: 1 },
];
const open = (lines = LINES): CustomerReturnView => ({ open: true, deadline: DEADLINE, lines, returns: [] });
const asked = (status: CustomerReturnView["returns"][number]["status"]) => ({ returnNo: "RTABC123", status, lines: [{ name: "測試商品", qty: 1 }], createdAt: Date.UTC(2026, 9, 8, 4, 0) });

const render = (view: CustomerReturnView, over: Partial<ReturnRequestViewProps> = {}) =>
  renderToStaticMarkup(createElement(ReturnRequestView, { view, asking: false, busy: false, onAsk: () => {}, onCancel: () => {}, onSubmit: () => {}, ...over }));
const input = (html: string, name: string) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? "";

describe("設定:客人可以申請退貨的天數", () => {
  it("一個數字,預設 0(升級的店不會多出任何東西),說明寫了 0 是不開放", () => {
    expect(SHOP_RETURN_SETTINGS).toHaveLength(1);
    const [field] = SHOP_RETURN_SETTINGS;
    expect(field).toMatchObject({ key: "customerReturnDays", type: "number", default: 0, label: "客人可以申請退貨的天數（出貨後）" });
    expect(String(field.description)).toContain("0 是不開放");
    expect(validateSettingValue(field, field.default)).toBeNull();
    expect(`ext.shop.${field.key}`).toBe(CUSTOMER_RETURN_DAYS_KEY);
    expect(customerReturnDays(field.default)).toBe(0);
  });
});

describe("送什麼到哪裡", () => {
  it("商店的公開路由;訪客帶下單的 Email,會員不帶;沒有任何金額的欄位", () => {
    expect(RETURN_REQUEST_URL).toBe("/api/ext/shop/returns/customer");
    expect(returnRequestBody({ orderNo: "SM1" })).toEqual({ action: "status", orderNo: "SM1" });
    expect(returnRequestBody({ orderNo: "SM1", email: "a@example.com" })).toEqual({ action: "status", orderNo: "SM1", email: "a@example.com" });
    const body = returnRequestBody({ orderNo: "SM1", email: "a@example.com" }, { lines: [{ productId: "p1", qty: 1 }], reason: "defective", note: "  外盒破損 " });
    expect(body).toEqual({ action: "request", orderNo: "SM1", email: "a@example.com", lines: [{ productId: "p1", qty: 1 }], reason: "defective", note: "外盒破損" });
    expect(returnRequestBody({ orderNo: "SM1" }, { lines: [{ productId: "p1", qty: 1 }], reason: "other", note: "  " })).toEqual({ action: "request", orderNo: "SM1", lines: [{ productId: "p1", qty: 1 }], reason: "other" });
    expect(JSON.stringify(body)).not.toMatch(/amount/i);
  });

  it("只有已出貨、已完成的訂單才有這一區", () => {
    expect(["shipped", "completed"].map(showsReturnRequest)).toEqual([true, true]);
    expect(["pending_payment", "awaiting_verify", "paid", "cancelled", "refunded", ""].map(showsReturnRequest)).toEqual([false, false, false, false, false, false]);
  });

  it("件數:只有一項時預設全退,多項時由客人挑;送出的只有挑了的,而且不超過能退的", () => {
    expect(defaultReturnQty([LINES[0]])).toEqual({ p1: 2 });
    expect(defaultReturnQty(LINES)).toEqual({ p1: 0, p2: 0 });
    expect(pickedLines(LINES, { p1: 1, p2: 0 })).toEqual([{ productId: "p1", qty: 1 }]);
    expect(pickedLines(LINES, { p1: 9, p2: 1.7, nope: 3 })).toEqual([{ productId: "p1", qty: 2 }, { productId: "p2", qty: 1 }]);
    expect(pickedLines(LINES, { p1: -1, p2: Number.NaN })).toEqual([]);
  });

  it("送出:POST JSON;成功拿到新的畫面,失敗拿到錯誤碼,連不上是 network", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const ok = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return Response.json({ ok: true, returnNo: "RT1", view: open() });
    }) as typeof fetch;
    expect(await callReturnRequest(returnRequestBody({ orderNo: "SM1" }), ok)).toEqual({ ok: true, returnNo: "RT1", view: open() });
    expect(calls[0][0]).toBe(RETURN_REQUEST_URL);
    expect(calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify({ action: "status", orderNo: "SM1" }) });
    const refused = (async () => Response.json({ ok: false, error: "window_passed" }, { status: 409 })) as typeof fetch;
    expect(await callReturnRequest(returnRequestBody({ orderNo: "SM1" }), refused)).toEqual({ ok: false, error: "window_passed" });
    const broken = (async () => new Response("<html>", { status: 500 })) as typeof fetch;
    expect(await callReturnRequest(returnRequestBody({ orderNo: "SM1" }), broken)).toEqual({ ok: false, error: "server_error" });
    const offline = (async () => { throw new Error("offline"); }) as typeof fetch;
    expect(await callReturnRequest(returnRequestBody({ orderNo: "SM1" }), offline)).toEqual({ ok: false, error: "network" });
  });
});

describe("給客人看的字", () => {
  it("每個退貨狀態、每個原因都有中文的講法", () => {
    for (const status of RETURN_STATUSES) expect(CUSTOMER_RETURN_LABELS[status], status).toMatch(/[一-鿿]/);
    for (const reason of RETURN_REASONS) expect(CUSTOMER_REASON_LABELS[reason], reason).toMatch(/[一-鿿]/);
    expect([CUSTOMER_RETURN_LABELS.requested, CUSTOMER_RETURN_LABELS.approved, CUSTOMER_RETURN_LABELS.rejected, CUSTOMER_RETURN_LABELS.refunded]).toEqual(["申請中", "已同意", "已拒絕", "已退款"]);
    // 原因是客人自己選的:不寫「客人不想要了」。
    expect(Object.values(CUSTOMER_REASON_LABELS).join()).not.toContain("客人");
  });

  it("伺服器會回的每個錯誤碼都有一句話;不認得的用同一句,不把代碼給客人看", () => {
    for (const code of ["not_found", "invalid_input", "closed", "window_passed", "order_not_returnable", "order_closed", "qty_exceeds", "changed", "rate_limited", "not_ready", "network"]) {
      const text = explainReturnRequestError(code);
      expect(text, code).toMatch(/[一-鿿]/);
      expect(text, code).not.toContain(code);
    }
    expect(explainReturnRequestError("stock_untracked")).toBe(explainReturnRequestError(undefined));
    expect(explainReturnRequestError("server_error")).toBe("申請沒有送出，請再試一次。");
  });

  it("畫面已經對不上的錯誤(件數、期限、店家關掉)要重新問一次;連線、太頻繁、少填的不用", () => {
    expect(["qty_exceeds", "changed", "closed", "window_passed", "order_not_returnable", "order_closed"].every(isStaleReturnError)).toBe(true);
    expect(["network", "rate_limited", "invalid_input", "not_ready", "server_error", "not_found"].some(isStaleReturnError)).toBe(false);
  });
});

describe("訂單上的退貨區", () => {
  it("沒開放、也沒有退貨:什麼都不畫", () => {
    expect(render({ open: false, blocked: "closed", deadline: null, lines: [], returns: [] })).toBe("");
    expect(render({ open: false, blocked: "not_returnable", deadline: null, lines: [], returns: [] })).toBe("");
    expect(render({ open: false, blocked: "nothing_left", deadline: DEADLINE, lines: [], returns: [] })).toBe("");
  });

  it("還沒出貨的訂單:整個元件不出現(也不問伺服器)", () => {
    expect(renderToStaticMarkup(createElement(ReturnRequest, { orderNo: "SM1", status: "paid" }))).toBe("");
    // 已出貨的訂單在拿到伺服器的回答之前也是空的。
    expect(renderToStaticMarkup(createElement(ReturnRequest, { orderNo: "SM1", status: "shipped" }))).toBe("");
  });

  it("可以申請:一顆「申請退貨」與期限,還沒按之前沒有表單", () => {
    const html = render(open());
    expect(html).toMatch(/<button type="button"[^>]*>申請退貨<\/button>/);
    expect(html).toContain("2026/10/15 14:05 前可以申請。");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<select");
  });

  it("按了之後:每一項能退幾件、原因、說明;沒有任何填金額的地方", () => {
    const html = render(open(), { asking: true });
    expect(html).toContain("測試商品");
    expect(html).toContain("最多 2 件");
    expect(input(html, "qty:p1")).toContain('max="2"');
    expect(input(html, "qty:p1")).toContain('min="0"');
    expect(input(html, "qty:p1")).toContain('value="0"');
    expect(input(html, "qty:p2")).toContain('max="1"');
    for (const label of Object.values(CUSTOMER_REASON_LABELS)) expect(html).toContain(`>${label}</option>`);
    expect(html).toMatch(/<textarea[^>]*name="note"[^>]*maxLength="500"/);
    expect(html).toContain("送出後要等店家同意，退款金額由店家決定。");
    expect(html).toMatch(/<button type="submit"[^>]*>送出申請<\/button>/);
    expect(html).toMatch(/<button type="button"[^>]*>先不要<\/button>/);
    expect(html).not.toMatch(/name="(amount|requestedAmount)"|NT\$|金額<\/label>/);
  });

  it("只有一項商品:件數先帶可以退的那個數", () => {
    expect(input(render(open([LINES[0]]), { asking: true }), "qty:p1")).toContain('value="2"');
  });

  it("送出中:按鈕停用;有錯誤時那一句寫在按鈕上面", () => {
    const html = render(open(), { asking: true, busy: true, error: "請選擇要退的商品和件數。" });
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>送出中…<\/button>/);
    expect(html.indexOf('role="alert"')).toBeGreaterThan(-1);
    expect(html.indexOf("請選擇要退的商品和件數。")).toBeLessThan(html.indexOf("送出中…"));
  });

  it("申請過:同一張訂單上看得到那筆退貨與它的進度(客人的講法)、退貨編號", () => {
    const html = render({ ...open([LINES[1]]), returns: [asked("requested")] }, { notice: RETURN_ASKED });
    expect(html).toContain("退貨申請");
    expect(html).toContain("測試商品 × 1");
    expect(html).toContain("申請中");
    expect(html).toContain("RTABC123");
    expect(html).toContain("2026/10/8");
    expect(html).toMatch(/role="status"[^>]*>已送出退貨申請，您可以在這張訂單查看進度。</);
    // 還有沒申請過的商品:照樣可以再申請那幾項。
    expect(html).toContain(">申請退貨</button>");
    for (const [status, label] of [["approved", "已同意"], ["rejected", "已拒絕"], ["refunded", "已退款"]] as const) {
      expect(render({ open: false, blocked: "nothing_left", deadline: DEADLINE, lines: [], returns: [asked(status)] })).toContain(label);
    }
  });

  it("商品都申請過了、或店家沒開放:只有進度,沒有「申請退貨」", () => {
    for (const blocked of ["nothing_left", "closed"] as const) {
      const html = render({ open: false, blocked, deadline: null, lines: [], returns: [asked("approved")] });
      expect(html).toContain("已同意");
      expect(html).not.toContain(">申請退貨</button>");
    }
  });

  it("過了期限:說期限是什麼時候,沒有按鈕", () => {
    const html = render({ open: false, blocked: "window_passed", deadline: DEADLINE, lines: [], returns: [] });
    expect(html).toContain("已超過申請退貨的期限（2026/10/15 14:05）。");
    expect(html).not.toContain("<button");
  });

  it("送出時才發現不能申請了(表單收起來):那一句錯誤留在這一區,不會不見", () => {
    const html = render({ open: false, blocked: "nothing_left", deadline: DEADLINE, lines: [], returns: [asked("requested")] }, { asking: true, error: explainReturnRequestError("qty_exceeds") });
    expect(html).toMatch(/role="alert"[^>]*>可以退的件數變了，請再確認一次。</);
    expect(html).not.toContain("<form");
  });

  it("進度是靜態的字,沒有會動的指示", () => {
    const html = render({ ...open(), returns: [asked("requested")] }, { asking: true });
    expect(html).not.toMatch(/animate-|ping|pulse/);
  });
});
