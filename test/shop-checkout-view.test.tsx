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

type Props = Parameters<typeof CheckoutView>[0];
const render = (props: Partial<Props>) =>
  renderToStaticMarkup(
    createElement(CheckoutView, { cardEnabled: false, transferEnabled: true, ...props }),
  );

const phoneInput = (html: string) => html.match(/<input[^>]*id="shop-phone"[^>]*>/)?.[0] ?? "";
const addressInput = (html: string) => html.match(/<input[^>]*id="shop-address"[^>]*>/)?.[0] ?? "";

describe("CheckoutView switches", () => {
  it("renders the legacy guest checkout with optional contact fields", () => {
    const html = render({});
    expect(html).toContain("電話（選填）");
    expect(html).toContain("收件地址（選填）");
    expect(phoneInput(html)).not.toContain("required");
    expect(html).not.toContain("shop-referral");
    expect(html).not.toContain("結帳前請先");
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

  it("managed orders: sign-in prompt, required contact and the referral field", () => {
    const html = render({ managedOrders: true });
    // next/link 在這裡退成純文字:「登入」與「我的訂單」各是一個連結。
    expect(html).toContain("結帳前請先登入會員 · 我的訂單");
    expect(phoneInput(html)).toContain("required");
    expect(addressInput(html)).toContain("required");
    expect(html).toContain('id="shop-referral"');
    expect(html).toContain("推薦碼（選填）");
  });

  it("managed orders: signed-in members see no login prompt", () => {
    const html = render({ managedOrders: true, signedIn: true });
    // 「已登入會員 · 我的訂單」:句號和 · 不會撞在一起。
    expect(html).toContain("已登入會員 · 我的訂單");
    expect(html).not.toContain("已登入會員。");
    expect(html).not.toContain("結帳前請先");
  });

  it("managed orders: link and off modes hide the referral field", () => {
    for (const referralMode of ["link", "off"] as const) {
      const html = render({ managedOrders: true, referralMode });
      expect(html, referralMode).not.toContain("shop-referral");
      expect(html, referralMode).toContain("我的訂單");
    }
  });

  it("managed orders with guest checkout: no sign-in gate, a sign-in link instead of 我的訂單", () => {
    const html = render({ managedOrders: true, guestCheckout: true });
    expect(html).toContain("已經是會員？");
    expect(html).toContain("登入");
    expect(html).not.toContain("結帳前請先");
    expect(html).not.toContain("我的訂單");
    // Guests fill in the same required contact fields as members.
    expect(phoneInput(html)).toContain("required");
    expect(addressInput(html)).toContain("required");
    // A signed-in member keeps the member header even when guests are allowed.
    const member = render({ managedOrders: true, signedIn: true, guestCheckout: true });
    expect(member).toContain("已登入會員 · ");
    expect(member).not.toContain("已經是會員？");
  });

  it("guest checkout needs managed orders; the legacy checkout shows no sign-in line", () => {
    expect(render({ guestCheckout: true })).not.toContain("已經是會員？");
  });

  it("a site's onSignIn turns 登入 into a button instead of the /login link", () => {
    const html = render({ managedOrders: true, guestCheckout: true, onSignIn: () => {} });
    expect(html).toMatch(/<button type="button"[^>]*>登入<\/button>/);
  });

  it("legacy checkout never shows the referral field even if asked", () => {
    expect(render({ referralMode: "field" })).not.toContain("shop-referral");
  });

  it("the promo code example is not a code that looks real", () => {
    const html = render({ promoEnabled: true });
    expect(html).toContain('placeholder="EXAMPLE10"');
    expect(html).not.toContain("WELCOME10");
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
    const values = [...html.matchAll(/<dd class="([^"]*)"/g)].map((m) => m[1]);
    expect(values).toHaveLength(2);
    for (const cls of values) {
      expect(cls).toContain("[overflow-wrap:anywhere]");
      expect(cls).toContain("min-w-0");
    }
    expect(html).toContain("SM05B6686AD86846E598D347E15A91");
  });
});
