import { describe, expect, it } from "vitest";

// shop 0.2.0 結帳頁開關:設定定義與正規化函式(純邏輯,不碰 D1 與 React)。
// public-pages.tsx 把 D1 讀出的原始值餵進 resolveCheckoutOptions,CheckoutView
// 對 props 再跑一次 —— 這裡鎖住兩件事:預設值合法、受管/非受管的優先序不變。

import {
  CHECKOUT_NOTICE_KEY,
  checkoutContact,
  REFERRAL_MODES,
  REFERRAL_MODE_KEY,
  REQUIRE_CONTACT_KEY,
  SHOP_CHECKOUT_SETTINGS,
  resolveCheckoutOptions,
} from "../extensions/shop/checkout-options";
import { validateSettingValue } from "../src/lib/setting-validation";

describe("shop checkout settings", () => {
  it("declares defaults the shared validator accepts", () => {
    for (const field of SHOP_CHECKOUT_SETTINGS) {
      expect(validateSettingValue(field, field.default), field.key).toBeNull();
    }
  });

  it("uses unique keys that match the exported full keys", () => {
    const keys = SHOP_CHECKOUT_SETTINGS.map((field) => `ext.shop.${field.key}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(
      expect.arrayContaining([REFERRAL_MODE_KEY, REQUIRE_CONTACT_KEY, CHECKOUT_NOTICE_KEY]),
    );
  });

  it("offers exactly the referral modes the resolver understands", () => {
    const field = SHOP_CHECKOUT_SETTINGS.find((f) => f.key === "referralMode");
    expect(field?.type).toBe("select");
    if (field?.type !== "select") return;
    expect(field.options.map((option) => option.value)).toEqual([...REFERRAL_MODES]);
    expect(field.default).toBe("field");
  });
});

describe("resolveCheckoutOptions", () => {
  it("keeps the legacy checkout untouched by default", () => {
    expect(resolveCheckoutOptions({ managedOrders: false })).toEqual({
      managedOrders: false,
      signedIn: false,
      guestCheckout: false,
      referralMode: "off",
      requireContact: false,
      notice: "",
    });
  });

  it("ignores referral settings and sign-in outside managed orders", () => {
    const options = resolveCheckoutOptions({
      managedOrders: false,
      signedIn: true,
      referralMode: "field",
    });
    expect(options.referralMode).toBe("off");
    expect(options.signedIn).toBe(false);
  });

  it("lets a legacy shop require phone and address", () => {
    expect(resolveCheckoutOptions({ managedOrders: false, requireContact: true }).requireContact).toBe(true);
    // Only a real boolean counts; D1 returns whatever JSON was stored.
    expect(resolveCheckoutOptions({ managedOrders: false, requireContact: "true" }).requireContact).toBe(false);
  });

  it("forces contact fields and defaults the referral field on managed orders", () => {
    expect(resolveCheckoutOptions({ managedOrders: true, requireContact: false })).toEqual({
      managedOrders: true,
      signedIn: false,
      guestCheckout: false,
      referralMode: "field",
      requireContact: true,
      notice: "",
    });
  });

  it("honours link and off referral modes on managed orders", () => {
    expect(resolveCheckoutOptions({ managedOrders: true, referralMode: "link" }).referralMode).toBe("link");
    expect(resolveCheckoutOptions({ managedOrders: true, referralMode: "off" }).referralMode).toBe("off");
  });

  it("falls back to the referral field when the stored value is unknown", () => {
    expect(resolveCheckoutOptions({ managedOrders: true, referralMode: "banner" }).referralMode).toBe("field");
    expect(resolveCheckoutOptions({ managedOrders: true, referralMode: 3 }).referralMode).toBe("field");
  });

  it("trims the notice and drops non-string values", () => {
    expect(resolveCheckoutOptions({ checkoutNotice: "  週三出貨\n自取請先來電  " }).notice).toBe("週三出貨\n自取請先來電");
    expect(resolveCheckoutOptions({ checkoutNotice: { text: "x" } }).notice).toBe("");
    expect(resolveCheckoutOptions({ checkoutNotice: "   " }).notice).toBe("");
  });

  it("only reports sign-in on managed orders", () => {
    expect(resolveCheckoutOptions({ managedOrders: true, signedIn: true }).signedIn).toBe(true);
    expect(resolveCheckoutOptions({ managedOrders: true }).signedIn).toBe(false);
  });

  it("0.7.0:guest checkout only on managed orders, and only a real true counts", () => {
    expect(resolveCheckoutOptions({ managedOrders: true, guestCheckout: true }).guestCheckout).toBe(true);
    expect(resolveCheckoutOptions({ managedOrders: false, guestCheckout: true }).guestCheckout).toBe(false);
    expect(resolveCheckoutOptions({ managedOrders: true, guestCheckout: "true" }).guestCheckout).toBe(false);
    expect(resolveCheckoutOptions({ managedOrders: true }).guestCheckout).toBe(false);
    // Contact fields stay required for guests, same as members.
    expect(resolveCheckoutOptions({ managedOrders: true, guestCheckout: true }).requireContact).toBe(true);
  });

  it("is idempotent so CheckoutView can re-run it on its props", () => {
    const first = resolveCheckoutOptions({
      managedOrders: true,
      signedIn: true,
      guestCheckout: true,
      referralMode: "link",
      requireContact: false,
      checkoutNotice: " 預購商品 ",
    });
    expect(resolveCheckoutOptions({ ...first, checkoutNotice: first.notice })).toEqual(first);
  });
});

describe("checkoutContact(0.7.0:已登入的人結帳時先帶入 Email 與姓名)", () => {
  it("沒登入 → 什麼都不帶", () => {
    expect(checkoutContact(null)).toEqual({});
  });

  it("帶入帳號的 Email 與姓名", () => {
    expect(checkoutContact({ email: "amy@example.com", name: "王小美" })).toEqual({ email: "amy@example.com", name: "王小美" });
  });

  it("姓名只是 Email @ 前面那段(沒填名字的預設)→ 不帶姓名", () => {
    expect(checkoutContact({ email: "amy@example.com", name: "amy" })).toEqual({ email: "amy@example.com" });
  });

  it("拿不到真實 Email 的第三方登入 → 不帶 Email", () => {
    expect(checkoutContact({ email: "oauth-line-1a2b3c4d@placeholder.invalid", name: "小美" })).toEqual({ name: "小美" });
  });
});

