import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// CheckoutView 的伺服器端渲染快照:三個開關在表單上的可見效果。
// 購物車 store 以 fake 取代(useSyncExternalStore 在 SSR 走 server snapshot),
// next/link 退成純文字 —— 測的是欄位有沒有出現、必填有沒有掛上,不是樣式。

vi.mock("next/link", () => ({
  default: ({ children }: { children: unknown }) => children,
}));

const ITEMS = [{ productId: "p1", name: "芋頭粿", unitPrice: 120, qty: 2 }];
vi.mock("../extensions/shop/cart-store", () => ({
  subscribeCart: () => () => {},
  getCartSnapshot: () => ITEMS,
  getCartServerSnapshot: () => ITEMS,
  cartSubtotal: (items: { unitPrice: number; qty: number }[]) =>
    items.reduce((sum, item) => sum + item.unitPrice * item.qty, 0),
  clearCart: () => {},
}));

import { CheckoutView } from "../extensions/shop/CheckoutView";

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
    expect(html).toContain("電話(選填)");
    expect(html).toContain("收件地址(選填)");
    expect(phoneInput(html)).not.toContain("required");
    expect(html).not.toContain("shop-referral");
    expect(html).not.toContain("請先登入會員後結帳");
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
    expect(html).toContain("請先登入會員後結帳");
    expect(html).toContain("我的訂單");
    expect(phoneInput(html)).toContain("required");
    expect(addressInput(html)).toContain("required");
    expect(html).toContain('id="shop-referral"');
    expect(html).toContain("推薦碼(選填)");
  });

  it("managed orders: signed-in members see no login prompt", () => {
    const html = render({ managedOrders: true, signedIn: true });
    expect(html).toContain("已登入會員。");
    expect(html).not.toContain("請先登入會員後結帳");
  });

  it("managed orders: link and off modes hide the referral field", () => {
    for (const referralMode of ["link", "off"] as const) {
      const html = render({ managedOrders: true, referralMode });
      expect(html, referralMode).not.toContain("shop-referral");
      expect(html, referralMode).toContain("我的訂單");
    }
  });

  it("legacy checkout never shows the referral field even if asked", () => {
    expect(render({ referralMode: "field" })).not.toContain("shop-referral");
  });
});
