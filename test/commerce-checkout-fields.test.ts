import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECKOUT_FIELDS_CAPABILITY,
  checkoutFieldsBodySchema,
  listCheckoutFields,
  publicCheckoutFields,
  validateCheckoutFields,
  type CheckoutField,
  type CheckoutFieldDraft,
} from "../src/ext/commerce-kit/checkout-fields";
import {
  CHECKOUT_PREFILL_KEY,
  forgetCheckoutValue,
  readCheckoutValue,
  rememberCheckoutValue,
} from "../src/ext/commerce-kit/checkout-prefill";
import { parseOrderMeta } from "../src/ext/commerce-kit/orders";

// commerce-kit 1.63.0:結帳欄位(capability commerce:checkout-fields)與瀏覽器端的預先帶入。

function registry(providers: Record<string, unknown>) {
  return {
    list: (capability: string) => (capability === CHECKOUT_FIELDS_CAPABILITY ? Object.keys(providers).map((id) => ({ id })) : []),
    getById: <T,>(capability: string, id: string) => (capability === CHECKOUT_FIELDS_CAPABILITY ? ((providers[id] ?? null) as T | null) : null),
  };
}
const provide = (...fields: CheckoutField[]) => ({ fields: async () => fields });
const draft: CheckoutFieldDraft = {
  lines: [{ productId: "p1", name: "商品", unitPrice: 100, qty: 2 }],
  amounts: { subtotal: 200, discount: 0, shipping: 0, total: 200 },
  email: "buyer@example.com",
  userId: null,
};

describe("listCheckoutFields / publicCheckoutFields", () => {
  it("names each field <providerId>.<key>, in provider order, labels in the buyer's language", async () => {
    const providers = registry({
      gift: provide({ key: "note", label: { "zh-Hant": "賀卡內容", en: "Card message" }, input: "textarea", maxLength: 200 }),
      vip: provide({ key: "code", label: "會員編號", input: "hidden", maxLength: 20, required: true }),
    });
    const declared = await listCheckoutFields(providers);
    expect(declared.map((d) => d.name)).toEqual(["gift.note", "vip.code"]);
    expect(publicCheckoutFields(declared, "zh-Hant")).toEqual([
      { name: "gift.note", label: "賀卡內容", input: "textarea", maxLength: 200, required: false },
      { name: "vip.code", label: "會員編號", input: "hidden", maxLength: 20, required: true },
    ]);
    expect(publicCheckoutFields(declared, "en")[0].label).toBe("Card message");
  });

  it("skips a provider that throws and fields that are malformed, logging each", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const providers = registry({
        broken: { fields: async () => { throw new Error("settings down"); } },
        odd: provide(
          { key: "Bad Key", label: "x", input: "text", maxLength: 10 },
          { key: "long", label: "x", input: "text", maxLength: 501 },
          { key: "kind", label: "x", input: "select" as "text", maxLength: 10 },
          { key: "fine", label: "好的", input: "text", maxLength: 10 },
        ),
        none: {},
      });
      expect((await listCheckoutFields(providers)).map((d) => d.name)).toEqual(["odd.fine"]);
      expect(log).toHaveBeenCalledTimes(4);
    } finally {
      log.mockRestore();
    }
  });

  it("no providers: no fields", async () => {
    expect(await listCheckoutFields(registry({}))).toEqual([]);
  });
});

describe("validateCheckoutFields", () => {
  const code: CheckoutField = {
    key: "code",
    label: "推廣代碼",
    input: "text",
    maxLength: 10,
    errors: { self: "不能用自己的代碼。" },
    async validate(value, d) {
      if (value.toUpperCase() === "MINE" && d.email === "buyer@example.com") return { ok: false, code: "self" };
      if (value.toUpperCase() === "NOPE") return { ok: false, code: "invalid" };
      return { ok: true, value: value.toUpperCase() };
    },
  };
  const providers = registry({
    promo: provide(code, { key: "note", label: "備註", input: "textarea", maxLength: 5, required: true }),
  });

  it("returns the meta to store: the provider's value, trimmed input, unknown names ignored", async () => {
    expect(await validateCheckoutFields(providers, { "promo.code": " abc ", "promo.note": "早點送", "other.x": "ignored" }, draft)).toEqual({
      ok: true,
      meta: { "promo.code": "ABC", "promo.note": "早點送" },
    });
  });

  it("required, too long, the provider's own code and message, and a default message", async () => {
    const fail = async (fields: Record<string, string>) => {
      const result = await validateCheckoutFields(providers, fields, draft);
      return result.ok ? null : result.body;
    };
    expect(await fail({})).toEqual({ ok: false, error: "field_invalid", field: "promo.note", code: "required", message: "請填備註。" });
    expect(await fail({ "promo.note": "123456" })).toMatchObject({ field: "promo.note", code: "too_long", message: "備註最多 5 字。" });
    expect(await fail({ "promo.code": "mine", "promo.note": "x" })).toMatchObject({ field: "promo.code", code: "self", message: "不能用自己的代碼。" });
    expect(await fail({ "promo.code": "nope", "promo.note": "x" })).toMatchObject({ field: "promo.code", code: "invalid", message: "推廣代碼無法使用。" });
  });

  it("the request body: at most 20 fields of at most 500 characters", () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p.f${i}`, "x"]));
    expect(checkoutFieldsBodySchema.safeParse(many).success).toBe(false);
    expect(checkoutFieldsBodySchema.safeParse({ "p.f": "x".repeat(501) }).success).toBe(false);
    expect(checkoutFieldsBodySchema.safeParse({ "p.f": "ok" }).success).toBe(true);
  });
});

describe("parseOrderMeta", () => {
  it("keeps string values only; missing or broken meta is empty", () => {
    expect(parseOrderMeta('{"partner.code":"OK1","n":2}')).toEqual({ "partner.code": "OK1" });
    expect(parseOrderMeta(null)).toEqual({});
    expect(parseOrderMeta(undefined)).toEqual({});
    expect(parseOrderMeta("not json")).toEqual({});
    expect(parseOrderMeta("[1]")).toEqual({});
  });
});

describe("checkout prefill (checkout.prefill.v1)", () => {
  const memory = new Map<string, string>();
  beforeEach(() => {
    memory.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("remembers a value until it expires, under one key", () => {
    const now = 1_800_000_000_000;
    rememberCheckoutValue("partner.code", "SU001", { days: 30, now });
    expect(readCheckoutValue("partner.code", now + 29 * 86_400_000)).toBe("SU001");
    expect(readCheckoutValue("partner.code", now + 31 * 86_400_000)).toBe("");
    expect([...memory.keys()]).toEqual([CHECKOUT_PREFILL_KEY]);
  });

  it("forgets a value, only when it is the rejected one if a value is given", () => {
    rememberCheckoutValue("partner.code", "SU001");
    rememberCheckoutValue("gift.note", "生日快樂");
    forgetCheckoutValue("partner.code", "OTHER");
    expect(readCheckoutValue("partner.code")).toBe("SU001");
    forgetCheckoutValue("partner.code", "SU001");
    expect(readCheckoutValue("partner.code")).toBe("");
    expect(readCheckoutValue("gift.note")).toBe("生日快樂");
    forgetCheckoutValue("gift.note");
    expect(memory.has(CHECKOUT_PREFILL_KEY)).toBe(false);
  });

  it("broken storage, or none at all, means nothing is remembered", () => {
    memory.set(CHECKOUT_PREFILL_KEY, "not json");
    expect(readCheckoutValue("partner.code")).toBe("");
    vi.stubGlobal("localStorage", undefined);
    expect(() => rememberCheckoutValue("partner.code", "SU001")).not.toThrow();
    expect(readCheckoutValue("partner.code")).toBe("");
  });
});
