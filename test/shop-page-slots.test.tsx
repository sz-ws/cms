import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, cloneElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SlotRegistry, fill, type SlotSource } from "../src/ext/slots";

// 商店的購物車頁與結帳頁各開一個插槽(shop 0.12.0,extensions/shop/slots.ts):
//   - 沒有人填:跟原本一樣(購物車、結帳表單);
//   - 別的插件或站台用 wrap 包起來:拿得到這一頁的 props 與原本的內容,可以照畫、也可以換成自己的;
//   - 「繼續購物」連去哪:沒指定時,商品目錄開著就連它的列表頁。

const state = vi.hoisted(() => ({
  enabled: ["shop", "catalog"] as string[],
  sources: [] as unknown[],
}));

vi.mock("next/link", () => ({ default: ({ children, href }: { children: unknown; href: string }) => createElement("a", { href }, children as never) }));
vi.mock("@/lib/auth", () => ({ getSessionUser: async () => null }));
vi.mock("@/lib/settings", () => ({ getSetting: async (_key: string, fallback?: unknown) => fallback }));
vi.mock("@/lib/db", () => ({ db: () => ({}) }));
vi.mock("@/lib/cf", () => ({ getDB: () => ({}) }));
vi.mock("@/ext/commerce-kit", () => ({ listPromos: async () => [], parseShippingConfig: () => null }));
vi.mock("@/ext/loader", async () => {
  const { SlotRegistry: Registry } = await import("../src/ext/slots");
  return {
    getExtRuntime: async () => ({
      byId: (id: string) => (state.enabled.includes(id) ? { id } : undefined),
      enabled: [],
      slots: new Registry(state.sources as SlotSource[]),
    }),
  };
});
vi.mock("@/ext/services", () => ({ buildProviderRegistry: () => ({ list: () => [], getById: () => null }) }));
// 購物車與結帳表單本身不在這裡測:換成記號,印出它收到的「繼續購物」。
vi.mock("../extensions/shop/CartView", () => ({ CartView: ({ shopHref }: { shopHref?: string }) => createElement("div", { "data-shop": String(shopHref) }, "CART") }));
vi.mock("../extensions/shop/CheckoutView", () => ({
  CheckoutView: ({ shopHref, guestCheckout }: { shopHref?: string; guestCheckout: boolean }) => createElement("div", { "data-shop": String(shopHref), "data-guest": String(guestCheckout) }, "CHECKOUT"),
}));

import { ShopCartPage, ShopCheckoutPage } from "../extensions/shop/public-pages";
import { ShopCart, ShopCheckout } from "../extensions/shop/slots";

/** 把 async 的伺服器元件一層一層解開,再交給 renderToStaticMarkup(它不會等)。 */
async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolve));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  const { type, props } = node;
  if (typeof type === "function" && type.constructor.name === "AsyncFunction") return resolve(await (type as (p: unknown) => Promise<ReactNode>)(props));
  if (props.children === undefined) return node;
  return cloneElement(node, undefined, await resolve(props.children));
}
const html = async (node: ReactNode) => renderToStaticMarkup(await resolve(node));

beforeEach(() => {
  state.enabled = ["shop", "catalog"];
  state.sources = [];
});

describe("購物車頁", () => {
  it("沒有人填:原本的購物車,繼續購物連到商品目錄", async () => {
    expect(await html(await ShopCartPage({}))).toContain('<div data-shop="/products">CART</div>');
  });

  it("商品目錄沒開:不指定,購物車自己回首頁", async () => {
    state.enabled = ["shop"];
    expect(await html(await ShopCartPage({}))).toContain('<div data-shop="undefined">CART</div>');
  });

  it("直接畫這一頁時給的 shopHref 優先", async () => {
    expect(await html(await ShopCartPage({ shopHref: "/menu" }))).toContain('<div data-shop="/menu">CART</div>');
  });

  it("包起來的元件拿到 shopHref 與原本的購物車,可以照畫", async () => {
    state.sources = [{ extId: "site", fills: [fill(ShopCart, { wrap: ({ shopHref, children }) => createElement("section", { "data-wrap": shopHref }, children) })] }];
    expect(await html(await ShopCartPage({}))).toContain('<section data-wrap="/products"><div data-shop="/products">CART</div></section>');
  });

  it("包起來的元件也可以換成自己的購物車;標題還是商店那一個", async () => {
    state.sources = [{ extId: "site", fills: [fill(ShopCart, { wrap: () => createElement("p", null, "OWN CART") })] }];
    const out = await html(await ShopCartPage({}));
    expect(out).toContain("<p>OWN CART</p>");
    expect(out).not.toContain("CART</div>");
    expect(out).toContain("購物車");
  });
});

describe("結帳頁", () => {
  it("沒有人填:原本的結帳表單", async () => {
    expect(await html(await ShopCheckoutPage())).toContain('<div data-shop="/products" data-guest="false">CHECKOUT</div>');
  });

  it("包起來的元件拿到結帳表單的 props 與原本的表單", async () => {
    state.sources = [
      {
        extId: "members",
        fills: [fill(ShopCheckout, { wrap: ({ children, shopHref, signedIn }) => createElement("section", { "data-shop": shopHref, "data-signed-in": String(signedIn) }, children) })],
      },
    ];
    expect(await html(await ShopCheckoutPage())).toContain('<section data-shop="/products" data-signed-in="false"><div data-shop="/products" data-guest="false">CHECKOUT</div></section>');
  });

  it("兩層都包:插件在裡面,站台在外面", async () => {
    state.sources = [
      { extId: "site", layer: "site", fills: [fill(ShopCheckout, { wrap: ({ children }) => createElement("b", null, children) })] },
      { extId: "members", fills: [fill(ShopCheckout, { wrap: ({ children }) => createElement("i", null, children) })] },
    ];
    expect(new SlotRegistry(state.sources as SlotSource[]).explain(ShopCheckout).map((entry) => entry.ext)).toEqual(["members", "site"]);
    expect(await html(await ShopCheckoutPage())).toContain("<b><i><div");
  });
});
