import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 商店頁上連出去的地方,站台的殼可以換:
//   - 結帳頁的「登入」連到 signInHref(public-pages.tsx 給網站的登入頁,帶著回結帳頁的 ?next=);
//   - 空的購物車有「繼續購物」,連到 shopHref(站台的商品頁;沒給回首頁)。

const state = vi.hoisted(() => ({ items: [] as { productId: string; name: string; unitPrice: number; qty: number }[] }));

vi.mock("next/link", () => ({
  default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) =>
    createElement("a", { href, className }, children),
}));
vi.mock("../extensions/shop/cart-store", () => ({
  subscribeCart: () => () => {},
  getCartSnapshot: () => state.items,
  getCartServerSnapshot: () => state.items,
  cartSubtotal: (items: { unitPrice: number; qty: number }[]) => items.reduce((sum, item) => sum + item.unitPrice * item.qty, 0),
  clearCart: () => {},
  setQty: () => {},
}));

import { CheckoutView } from "../extensions/shop/CheckoutView";
import { CartView } from "../extensions/shop/CartView";

type CheckoutProps = Parameters<typeof CheckoutView>[0];
const checkout = (props: Partial<CheckoutProps>) =>
  renderToStaticMarkup(createElement(CheckoutView, { cardEnabled: false, transferEnabled: true, ...props }));
const signInHrefs = (html: string) => [...html.matchAll(/<a href="([^"]*)"[^>]*>登入<\/a>/g)].map((m) => m[1]);

beforeEach(() => {
  state.items = [];
});

describe("結帳頁的「登入」", () => {
  beforeEach(() => {
    state.items = [{ productId: "p1", name: "商品一", unitPrice: 120, qty: 1 }];
  });

  it("沒給 signInHref:連到 /login,帶著回結帳頁的 next(/login 會轉到網站的登入頁)", () => {
    expect(signInHrefs(checkout({ managedOrders: true }))).toEqual(["/login?next=%2Fshop%2Fcheckout"]);
    expect(signInHrefs(checkout({ managedOrders: true, guestCheckout: true }))).toEqual(["/login?next=%2Fshop%2Fcheckout"]);
  });

  it("給了 signInHref:要求登入與訪客結帳的「登入」都連過去", () => {
    const href = "/account/sign-in?next=%2Fshop%2Fcheckout";
    expect(signInHrefs(checkout({ managedOrders: true, signInHref: href }))).toEqual([href]);
    expect(signInHrefs(checkout({ managedOrders: true, guestCheckout: true, signInHref: href }))).toEqual([href]);
  });
});

describe("空的購物車", () => {
  it("有「繼續購物」,連到站台給的商品頁", () => {
    const html = renderToStaticMarkup(createElement(CartView, { shopHref: "/catalog" }));
    expect(html).toContain("購物車是空的。");
    expect(html).toMatch(/<a href="\/catalog"[^>]*>繼續購物<\/a>/);
  });

  it("沒給商品頁:回首頁", () => {
    expect(renderToStaticMarkup(createElement(CartView))).toMatch(/<a href="\/"[^>]*>繼續購物<\/a>/);
  });

  it("有東西時沒有「繼續購物」", () => {
    state.items = [{ productId: "p1", name: "商品一", unitPrice: 120, qty: 1 }];
    const html = renderToStaticMarkup(createElement(CartView, { shopHref: "/catalog" }));
    expect(html).not.toContain("繼續購物");
    expect(html).toContain("前往結帳");
  });
});
