import { afterEach, describe, expect, it, vi } from "vitest";

// 優惠碼的分享連結:任何公開頁的網址帶 ?promo=代碼,商店把它記在瀏覽器裡,結帳頁先帶入並套用,客人不用自己打。
//   1. 連結怎麼組、網址上的代碼怎麼讀、怎麼記與忘(commerce-kit/promo-link.ts,沒有 React)。
//   2. 商店在每一個公開頁記連結(filter:publicWidgets),並提供優惠碼目錄(commerce:promos)。
//   3. 結帳頁試算記下的代碼之後,哪些結果要把它忘掉(extensions/shop/checkout-request.ts)。
// 這裡只載入商店的宣告,頁面換成空元件,免得拉進整個 Next 的前端。

vi.mock("next/navigation", () => ({ useRouter: () => ({}), usePathname: () => "/", useSearchParams: () => new URLSearchParams(), redirect: () => {}, notFound: () => {} }));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("../extensions/shop/public-pages", () => ({ ShopCartPage: () => null, ShopCheckoutPage: () => null, ShopPageShell: () => null, loadShopCheckoutProps: async () => ({}) }));
vi.mock("../extensions/shop/admin-promos", () => ({ ShopPromosPage: () => null }));
vi.mock("../extensions/shop/admin-orders", () => ({ ShopOrdersPage: () => null }));
vi.mock("../extensions/shop/admin-verify", () => ({ ShopVerifyPage: () => null }));
vi.mock("../extensions/shop/admin-returns", () => ({ ShopReturnsPage: () => null }));
vi.mock("../extensions/shop/admin-shipping", () => ({ ShopShippingPage: () => null }));

import { forgetPromoLink, PROMO_LINK_DAYS, PROMO_PREFILL_NAME, promoCodeFromUrl, promoLink, rememberedPromoCode, rememberPromoLink } from "../src/ext/commerce-kit/promo-link";
import { readCheckoutValue, rememberCheckoutValue } from "../src/ext/commerce-kit/checkout-prefill";
import { isPromoCatalog, PROMOS_CAPABILITY } from "../src/ext/commerce-kit/promo-catalog";
import { normalizePublicWidgets } from "../src/ext/public-widgets";
import { shop } from "../extensions/shop";
import { PromoLinkWidget } from "../extensions/shop/promo-link-widget";
import { linkedPromoDisplay, linkedPromoOutcome } from "../extensions/shop/checkout-request";
import type { CoreServices } from "../src/ext/services";

const DAY = 86_400_000;
function stubStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  });
  return store;
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("優惠碼連結", () => {
  it("puts the code on a path of the site, with the site's address in front when given", () => {
    expect(promoLink("SAVE10")).toBe("/?promo=SAVE10");
    expect(promoLink(" save10 ", { path: "/products" })).toBe("/products?promo=SAVE10");
    expect(promoLink("SAVE10", { origin: "https://shop.example/", path: "/products" })).toBe("https://shop.example/products?promo=SAVE10");
    expect(promoLink("SAVE10", { origin: "https://shop.example", path: "/products?sort=new" })).toBe("https://shop.example/products?sort=new&promo=SAVE10");
  });
  it("reads the code off a URL in any letter case, and nothing when it could not be a promo code", () => {
    expect(promoCodeFromUrl("https://shop.example/products?promo=save10&ref=A001")).toBe("SAVE10");
    expect(promoCodeFromUrl("https://shop.example/?utm=x&promo=VIP_2026-A")).toBe("VIP_2026-A");
    const bad = ["https://shop.example/", "https://shop.example/?promo=", "https://shop.example/?promo=A", "https://shop.example/?promo=has%20space", "https://shop.example/?promo=-ABC", `https://shop.example/?promo=${"A".repeat(41)}`, "https://shop.example/?PROMO=SAVE10", "not a url"];
    for (const href of bad) expect(promoCodeFromUrl(href)).toBe("");
  });
  it("remembers the code from a link for 30 days and replaces it with a newer link", () => {
    stubStorage();
    const now = 1_800_000_000_000;
    expect(rememberPromoLink("https://shop.example/products?promo=save10", now)).toBe("SAVE10");
    expect(rememberedPromoCode(now + (PROMO_LINK_DAYS - 1) * DAY)).toBe("SAVE10");
    expect(rememberedPromoCode(now + (PROMO_LINK_DAYS + 1) * DAY)).toBe("");
    // 沒有帶代碼的頁面不動記下的值;新的連結取代舊的。
    expect(rememberPromoLink("https://shop.example/products", now)).toBe("");
    expect(rememberedPromoCode(now)).toBe("SAVE10");
    rememberPromoLink("https://shop.example/?promo=VIP20", now);
    expect(rememberedPromoCode(now)).toBe("VIP20");
    // 記在結帳帶入的同一個地方,名字沒有點,不會和結帳欄位撞名。
    expect(PROMO_PREFILL_NAME).not.toContain(".");
    expect(readCheckoutValue(PROMO_PREFILL_NAME, now)).toBe("VIP20");
  });
  it("forgets on request, only the named code when one is given, and leaves checkout fields alone", () => {
    stubStorage();
    rememberCheckoutValue("partner.code", "A001");
    rememberPromoLink("https://shop.example/?promo=SAVE10");
    forgetPromoLink("OTHER");
    expect(rememberedPromoCode()).toBe("SAVE10");
    forgetPromoLink("SAVE10");
    expect(rememberedPromoCode()).toBe("");
    rememberPromoLink("https://shop.example/?promo=SAVE10");
    forgetPromoLink();
    expect(rememberedPromoCode()).toBe("");
    expect(readCheckoutValue("partner.code")).toBe("A001");
  });
  it("does nothing when the browser has no storage, and ignores a stored value that is not a code", () => {
    expect(rememberPromoLink("https://shop.example/?promo=SAVE10")).toBe("SAVE10");
    expect(rememberedPromoCode()).toBe("");
    stubStorage();
    rememberCheckoutValue(PROMO_PREFILL_NAME, "<script>");
    expect(rememberedPromoCode()).toBe("");
  });
});

describe("商店", () => {
  it("captures a promo link on every public page, next to the widgets other plugins put there", () => {
    const filter = shop.hooks?.["filter:publicWidgets"] as (widgets: unknown) => unknown;
    const Other = () => null;
    expect(normalizePublicWidgets(filter([Other]))).toEqual([Other, PromoLinkWidget]);
    // 前一個 handler 交出來的不是陣列時,自己的還是放得上去。
    expect(normalizePublicWidgets(filter(undefined))).toEqual([PromoLinkWidget]);
  });
  it("provides the promo catalog for its own table, with the page where the shop manages codes", () => {
    const provided = shop.provides?.find((p) => p.capability === PROMOS_CAPABILITY);
    const catalog = provided?.create({ db: {} } as unknown as CoreServices);
    expect(isPromoCatalog(catalog)).toBe(true);
    expect((catalog as { adminHref: string | null }).adminHref).toBe("/admin/ext/shop/promos");
  });
});

describe("結帳頁試算連結帶來的優惠碼之後", () => {
  it("forgets a code that will never work again, and keeps one the buyer can still come to use", () => {
    for (const reason of ["not_found", "disabled", "expired", "exhausted"]) expect(linkedPromoOutcome({ ok: false, error: "promo_invalid", reason })).toBe("forget");
    for (const reason of ["not_started", "below_min_subtotal"]) expect(linkedPromoOutcome({ ok: false, error: "promo_invalid", reason })).toBe("keep");
    // 試算沒有做成(太頻繁、格式錯誤):不是這個碼的問題,留著。
    expect(linkedPromoOutcome({ ok: false, error: "rate_limited" })).toBe("keep");
    expect(linkedPromoOutcome({ ok: true })).toBe("applied");
  });
  it("fills the promo field from the answer only when the buyer has not used the field in the meantime", () => {
    const answers = [{ ok: true as const }, { ok: false as const, error: "promo_invalid", reason: "expired" }, { ok: false as const, error: "promo_invalid", reason: "below_min_subtotal" }];
    // 客人還沒碰那一欄:帶入這個碼,能用就套用,不能用把原因寫出來。
    for (const reply of answers) expect(linkedPromoDisplay(reply, false)).toBe("show");
    // 試算還在路上,客人已經自己打了字、套用或拿掉一個碼:輸入框、套用的優惠碼、那一句錯誤都不動。
    for (const reply of answers) expect(linkedPromoDisplay(reply, true)).toBe("leave");
  });
  it("leaves the promo field alone and says nothing when the quote was not made", () => {
    // 太頻繁、格式錯誤:不是這個碼的答案。欄位空著(和連不上一樣),記下的碼留著下次再試。
    for (const error of ["rate_limited", "invalid_input"]) {
      expect(linkedPromoDisplay({ ok: false, error }, false)).toBe("leave");
      expect(linkedPromoDisplay({ ok: false, error }, true)).toBe("leave");
      expect(linkedPromoOutcome({ ok: false, error })).toBe("keep");
    }
  });
});
