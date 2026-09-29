import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// CheckoutView 的伺服器端渲染快照:三個開關在表單上的可見效果。
// 購物車 store 以 fake 取代(useSyncExternalStore 在 SSR 走 server snapshot),
// next/link 退成純文字 —— 測的是欄位有沒有出現、必填有沒有掛上,不是樣式。

vi.mock("next/link", () => ({
  default: ({ children }: { children: unknown }) => children,
}));

const ITEMS = [{ productId: "p1", name: "商品一", unitPrice: 120, qty: 2 }];
vi.mock("../extensions/shop/cart-store", () => ({
  subscribeCart: () => () => {},
  getCartSnapshot: () => ITEMS,
  getCartServerSnapshot: () => ITEMS,
  cartSubtotal: (items: { unitPrice: number; qty: number }[]) =>
    items.reduce((sum, item) => sum + item.unitPrice * item.qty, 0),
  clearCart: () => {},
}));

import { CheckoutView, InstructionLines } from "../extensions/shop/CheckoutView";
import { ManualResult, type ManualOrder } from "../extensions/shop/CheckoutResult";
import { needsSignIn, paymentDeadline } from "../extensions/shop/checkout-request";
import { DEFAULT_TRANSFER_REPORT_SPEC } from "../src/ext/payment-kit/report-spec";
import { createDateFormatter } from "../src/lib/datetime";

type Props = Parameters<typeof CheckoutView>[0];
const render = (props: Partial<Props>) =>
  renderToStaticMarkup(
    createElement(CheckoutView, { cardEnabled: false, transferEnabled: true, ...props }),
  );

const phoneInput = (html: string) => html.match(/<input[^>]*id="shop-phone"[^>]*>/)?.[0] ?? "";
const addressInput = (html: string) => html.match(/<input[^>]*id="shop-address"[^>]*>/)?.[0] ?? "";
const tagOf = (html: string, id: string) => html.match(new RegExp(`<(?:input|select)[^>]*id="${id}"[^>]*>`))?.[0] ?? "";

describe("CheckoutView switches", () => {
  it("renders the legacy guest checkout with optional contact fields", () => {
    const html = render({});
    expect(html).toContain("電話（選填）");
    expect(html).toContain("收件地址（選填）");
    expect(phoneInput(html)).not.toContain("required");
    expect(html).not.toContain("shop-field-");
    expect(html).not.toContain("請先登入會員");
    expect(html).not.toContain("我的訂單");
  });

  it("requires phone and address when the shop asks for them", () => {
    const html = render({ requireContact: true });
    expect(html).toContain(">電話</label>");
    expect(phoneInput(html)).toContain("required");
    expect(addressInput(html)).toContain("required");
  });

  it("shows the notice above the order summary", () => {
    const html = render({ notice: "每週三出貨\n自取請先來電" });
    expect(html).toContain("每週三出貨");
    expect(html).toContain("whitespace-pre-line");
    expect(html.indexOf("每週三出貨")).toBeLessThan(html.indexOf("小計"));
  });

  it("0.11.0: sign-in required and signed out — no form, a sign-in panel, and the order summary", () => {
    const html = render({ managedOrders: true, ordersHref: "/orders", notice: "每週三出貨" });
    expect(html).not.toContain("<form");
    for (const id of ["shop-name", "shop-email", "shop-phone", "shop-address"]) expect(html).not.toContain(`id="${id}"`);
    expect(html).not.toContain("成立訂單");
    expect(html).toContain("請先登入會員，登入後就能繼續結帳。");
    expect(html).toContain("登入");
    // 他們知道自己在買什麼:摘要還在,說明也在。
    expect(html).toContain("商品一 × 2");
    expect(html).toContain("合計");
    expect(html).toContain("每週三出貨");
    // 還沒登入,不放「我的訂單」。
    expect(html).not.toContain("我的訂單");
    expect(html).toMatch(/<h1[^>]*>結帳<\/h1>/);
    expect(html).toContain("回購物車");
  });

  it("managed orders: signed-in members fill the form with required contact, no login prompt", () => {
    const html = render({ managedOrders: true, signedIn: true, ordersHref: "/orders" });
    expect(html).toContain("<form");
    // 「已登入會員 · 我的訂單」:句號和 · 不會撞在一起。
    expect(html).toContain("已登入會員 · 我的訂單");
    expect(html).not.toContain("已登入會員。");
    expect(html).not.toContain("請先登入會員");
    expect(phoneInput(html)).toContain("required");
    expect(addressInput(html)).toContain("required");
    const without = render({ managedOrders: true, signedIn: true });
    expect(without).toContain("已登入會員");
    expect(without).not.toContain("我的訂單");
    expect(without).not.toContain(" · ");
  });

  it("managed orders with guest checkout: the form, and a sign-in link instead of 我的訂單", () => {
    const html = render({ managedOrders: true, guestCheckout: true });
    expect(html).toContain("<form");
    expect(html).toContain("已經是會員？");
    expect(html).toContain("登入");
    expect(html).not.toContain("請先登入會員");
    expect(html).not.toContain("我的訂單");
    // Guests fill in the same required contact fields as members.
    expect(phoneInput(html)).toContain("required");
    expect(addressInput(html)).toContain("required");
    // A signed-in member keeps the member header even when guests are allowed.
    const member = render({ managedOrders: true, signedIn: true, guestCheckout: true, ordersHref: "/orders" });
    expect(member).toContain("已登入會員 · ");
    expect(member).not.toContain("已經是會員？");
  });

  it("guest checkout needs managed orders; the legacy checkout shows no sign-in line", () => {
    expect(render({ guestCheckout: true })).not.toContain("已經是會員？");
  });

  it("a site's onSignIn turns 登入 into a button instead of the /login link", () => {
    const html = render({ managedOrders: true, guestCheckout: true, onSignIn: () => {} });
    expect(html).toMatch(/<button type="button"[^>]*>登入<\/button>/);
    // 要登入才能結帳的那一塊也一樣,而且是主要按鈕。
    const required = render({ managedOrders: true, onSignIn: () => {} });
    expect(required).toMatch(/<button type="button" class="[^"]*bg-black[^"]*">登入<\/button>/);
  });

  it("0.9.0: plugins' checkout fields — text and textarea drawn with their label, hidden ones not drawn", () => {
    const html = render({
      fields: [
        { name: "gift.note", label: "賀卡內容", input: "textarea", maxLength: 200, required: false },
        { name: "vip.code", label: "會員編號", input: "text", maxLength: 20, required: true },
        { name: "partner.link", label: "合作連結", input: "hidden", maxLength: 30, required: false },
      ],
    });
    const tag = (name: string) => html.match(new RegExp(`<(?:input|textarea)[^>]*name="${name}"[^>]*>`))?.[0] ?? "";
    expect(html).toContain(">賀卡內容（選填）</label>");
    expect(tag("gift.note")).toMatch(/^<textarea/);
    expect(tag("gift.note")).toContain('maxLength="200"');
    expect(tag("gift.note")).not.toContain("required");
    expect(html).toContain(">會員編號</label>");
    expect(tag("vip.code")).toContain('required=""');
    expect(html).not.toContain("合作連結");
    expect(html).not.toContain("partner.link");
  });

  it("0.11.0: the promo code field has no example code for shoppers to copy", () => {
    const html = render({ promoEnabled: true });
    const promo = html.match(/<input[^>]*id="shop-promo"[^>]*>/)?.[0] ?? "";
    expect(promo).not.toBe("");
    expect(promo).not.toContain("placeholder");
    expect(promo).toContain('autoComplete="off"');
    expect(html).not.toContain("EXAMPLE10");
    expect(html).not.toContain("WELCOME10");
  });

  it("0.11.0: contact fields tell the browser what to autofill", () => {
    const html = render({ shippingConfig: { methods: [{ id: "home", name: "宅配", base: 100, enabled: true }], rules: [] } });
    expect(tagOf(html, "shop-name")).toContain('autoComplete="name"');
    expect(tagOf(html, "shop-email")).toContain('autoComplete="email"');
    expect(tagOf(html, "shop-phone")).toContain('autoComplete="tel"');
    expect(tagOf(html, "shop-region")).toMatch(/^<select/);
    expect(tagOf(html, "shop-region")).toContain('autoComplete="address-level1"');
    expect(tagOf(html, "shop-address")).toContain('autoComplete="street-address"');
  });

  it("0.11.0: the form carries the page heading and the way back to the cart", () => {
    const html = render({});
    expect(html).toMatch(/<h1[^>]*>結帳<\/h1>/);
    expect(html).toContain("回購物車");
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("<form"));
  });
});

describe("checkout reply", () => {
  it("only unauthorized asks for sign-in", () => {
    expect(needsSignIn("unauthorized")).toBe(true);
    for (const code of ["invalid_input", "rate_limited", "checkout_paused", "請先填電話"]) expect(needsSignIn(code)).toBe(false);
  });

  it("the payment deadline is kept only when it is a real time", () => {
    expect(paymentDeadline(1_800_000_000_000)).toBe(1_800_000_000_000);
    for (const value of [undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1800000000000", {}]) {
      expect(paymentDeadline(value), String(value)).toBeNull();
    }
  });
});

describe("transfer instructions", () => {
  it("long codes such as the order number wrap instead of running off a phone-width card", () => {
    const html = renderToStaticMarkup(
      createElement(InstructionLines, {
        lines: [
          { label: "帳號", value: "TEST-ONLY-NOT-A-BANK-ACCOUNT" },
          { label: "訂單編號", value: "SM05B6686AD86846E598D347E15A91" },
        ],
      }),
    );
    const values = [...html.matchAll(/<dd class="[^"]*"><span class="([^"]*)"/g)].map((m) => m[1]);
    expect(values).toHaveLength(2);
    for (const cls of values) {
      expect(cls).toContain("[overflow-wrap:anywhere]");
      expect(cls).toContain("min-w-0");
    }
    expect(html).toContain("SM05B6686AD86846E598D347E15A91");
  });

  it("0.11.0: every line has its own copy button, named after the line", () => {
    const html = renderToStaticMarkup(
      createElement(InstructionLines, {
        lines: [
          { label: "銀行", value: "測試銀行" },
          { label: "帳號", value: "TEST-ONLY-000" },
          { label: "金額", value: "NT$ 450" },
        ],
      }),
    );
    const buttons = [...html.matchAll(/<button type="button"[^>]*>(.*?)<\/button>/g)].map((m) => m[1]);
    expect(buttons).toHaveLength(3);
    expect(buttons[1]).toContain('<span aria-live="polite">複製</span>');
    expect(buttons[1]).toContain('<span class="sr-only">帳號</span>');
    // 沒有會動的提示(專案紅線)。
    expect(html).not.toMatch(/animate-|transition/);
  });
});

describe("0.11.0: the order-placed screen", () => {
  const ORDER: ManualOrder = {
    orderNo: "SM0123456789ABCDEF",
    instructions: [
      { label: "銀行", value: "測試銀行" },
      { label: "帳號", value: "TEST-ONLY-000" },
      { label: "戶名", value: "測試商店" },
      { label: "金額", value: "NT$ 450" },
      { label: "訂單編號", value: "SM0123456789ABCDEF" },
    ],
    email: "buyer@example.com",
  };
  // 台北時間 2026/10/1 14:30。
  const DEADLINE = Date.UTC(2026, 9, 1, 6, 30);
  const placed = (order: ManualOrder, extra: { asGuest?: boolean; managed?: boolean; ordersHref?: string | null } = {}) =>
    renderToStaticMarkup(
      createElement(ManualResult, {
        order,
        spec: DEFAULT_TRANSFER_REPORT_SPEC,
        asGuest: false,
        managed: true,
        ordersHref: "/orders",
        ...extra,
      }),
    );

  it("says the order is placed, without the way back to the cart", () => {
    const html = placed(ORDER);
    expect(html).toMatch(/<h1[^>]*>訂單已成立<\/h1>/);
    expect(html).not.toContain(">結帳</h1>");
    expect(html).not.toContain("回購物車");
    // 標題已經說了,底下那句不再重複。
    expect(html).not.toContain("訂單已成立，");
  });

  it("writes the deadline above the transfer details in the site's time zone", () => {
    const html = placed({ ...ORDER, expiresAt: DEADLINE });
    const when = createDateFormatter("zh-Hant", "Asia/Taipei").dateTime(DEADLINE);
    expect(when).toBe("2026/10/1 14:30");
    expect(html).toContain(`請在 <span class="font-medium tabular-nums text-black/85">${when}</span> 前匯款到以下帳戶：`);
    expect(html.indexOf(when)).toBeLessThan(html.indexOf("TEST-ONLY-000"));
    expect(html).not.toContain("查看付款期限");
  });

  it("without a deadline, says what it said before", () => {
    expect(placed(ORDER)).toContain("請到「我的訂單」查看付款期限，並匯款到以下帳戶：");
    expect(placed(ORDER, { asGuest: true })).toContain("請匯款到以下帳戶：");
    expect(placed(ORDER, { ordersHref: null })).toContain("請匯款到以下帳戶：");
    expect(placed(ORDER, { managed: false, ordersHref: null })).toContain("請於三日內匯款到以下帳戶：");
    expect(placed({ ...ORDER, expiresAt: null })).not.toContain("請在 ");
  });

  it("every transfer detail has a copy button, the report form is still there", () => {
    const html = placed({ ...ORDER, expiresAt: DEADLINE });
    const copies = [...html.matchAll(/<span aria-live="polite">複製<\/span><span class="sr-only">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(copies).toEqual(["銀行", "帳號", "戶名", "金額", "訂單編號"]);
    expect(html).toContain(">回報匯款</h2>");
    expect(html).toContain("送出回報</button>");
  });
});
