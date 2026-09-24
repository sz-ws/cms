import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 額外欄位(core.content.extraFields,src/lib/extra-fields.ts)的純邏輯:設定的形狀、
// 寫入前的整理、對外出口只留公開值;加上 webhook 送出前會拿掉不公開的值。
//
// webhook 讀設定走 @/lib/settings:這裡整個 mock 掉,由測試決定定義是什麼、讀不讀得到。
const settingsState = vi.hoisted(() => ({
  extraFields: undefined as unknown,
  fail: false,
}));
vi.mock("@/lib/settings", () => ({
  getPlainSetting: async (key: string) => {
    if (settingsState.fail) throw new Error("db down");
    return key === "core.content.extraFields" ? settingsState.extraFields : undefined;
  },
  getSetting: async (_key: string, fallback?: unknown) => fallback,
  extSetting: (extId: string, key: string) => `ext.${extId}.${key}`,
}));

import {
  coerceExtraValues,
  extraFieldsSettingSchema,
  MAX_EXTRA_FIELDS,
  parseExtraFieldsSetting,
  publicExtras,
  withCoercedExtra,
  type ExtraFieldDef,
} from "../src/lib/extra-fields";
import { validateSettingValue } from "../src/lib/setting-validation";
import { makeWebhookHandler } from "../src/ext/dx/webhook";

const DEFS: ExtraFieldDef[] = [
  { key: "featured", label: "Featured", type: "boolean", public: true },
  { key: "subtitle", label: "Subtitle", type: "text", public: true },
  { key: "notes", label: "Notes", type: "textarea", public: false },
  { key: "cost", label: "Cost", type: "number", public: false },
];

describe("extraFieldsSettingSchema", () => {
  it("accepts a map of content type → field definitions", () => {
    const parsed = extraFieldsSettingSchema.parse({ "blog.post": DEFS });
    expect(parsed["blog.post"]).toHaveLength(4);
  });

  it("trims labels and rejects empty or long ones", () => {
    const parsed = extraFieldsSettingSchema.parse({
      "blog.post": [{ key: "a", label: "  Title  ", type: "text", public: false }],
    });
    expect(parsed["blog.post"][0].label).toBe("Title");
    const blank = { "blog.post": [{ key: "a", label: "   ", type: "text", public: false }] };
    expect(extraFieldsSettingSchema.safeParse(blank).success).toBe(false);
    const long = { "blog.post": [{ key: "a", label: "x".repeat(61), type: "text", public: false }] };
    expect(extraFieldsSettingSchema.safeParse(long).success).toBe(false);
  });

  it.each([
    ["uppercase start", "Notes"],
    ["digit start", "1st"],
    ["dash", "my-field"],
    ["space", "my field"],
    ["too long", `a${"b".repeat(40)}`],
    ["empty", ""],
  ])("rejects a bad key (%s)", (_name, key) => {
    const value = { "blog.post": [{ key, label: "X", type: "text", public: false }] };
    expect(extraFieldsSettingSchema.safeParse(value).success).toBe(false);
  });

  it("rejects duplicate keys within one type, allows the same key on another type", () => {
    const dup = {
      "blog.post": [
        { key: "a", label: "A", type: "text", public: false },
        { key: "a", label: "B", type: "number", public: true },
      ],
    };
    expect(extraFieldsSettingSchema.safeParse(dup).success).toBe(false);
    const split = {
      "blog.post": [{ key: "a", label: "A", type: "text", public: false }],
      "blog.page": [{ key: "a", label: "A", type: "text", public: false }],
    };
    expect(extraFieldsSettingSchema.safeParse(split).success).toBe(true);
  });

  it(`caps each type at ${MAX_EXTRA_FIELDS} fields`, () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ key: `f${i}`, label: `F${i}`, type: "text", public: false }));
    expect(extraFieldsSettingSchema.safeParse({ "blog.post": many(30) }).success).toBe(true);
    expect(extraFieldsSettingSchema.safeParse({ "blog.post": many(31) }).success).toBe(false);
  });

  it("rejects unknown types, unknown properties and bad content type keys", () => {
    const badType = { "blog.post": [{ key: "a", label: "A", type: "date", public: false }] };
    const extraProp = { "blog.post": [{ key: "a", label: "A", type: "text", public: false, hidden: true }] };
    const badTypeKey = { blog: [{ key: "a", label: "A", type: "text", public: false }] };
    for (const value of [badType, extraProp, badTypeKey, [], "x"]) {
      expect(extraFieldsSettingSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("parseExtraFieldsSetting", () => {
  it("treats a missing value as empty", () => {
    expect(parseExtraFieldsSetting(undefined)).toEqual({});
    expect(parseExtraFieldsSetting(null)).toEqual({});
  });

  it("treats a malformed stored value as empty and logs it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseExtraFieldsSetting({ "blog.post": "nope" })).toEqual({});
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("validateSettingValue(core.content.extraFields)", () => {
  const field = { key: "core.content.extraFields", type: "textarea" as const };

  it("accepts a valid definition map", () => {
    expect(validateSettingValue(field, { "blog.post": DEFS })).toBeNull();
    expect(validateSettingValue(field, {})).toBeNull();
  });

  it("rejects what the schema rejects, including JSON that is merely serialisable", () => {
    expect(validateSettingValue(field, "[]")).toBe("invalid_extra_fields");
    expect(validateSettingValue(field, null)).toBe("invalid_extra_fields");
    expect(
      validateSettingValue(field, {
        "blog.post": [
          { key: "a", label: "A", type: "text", public: false },
          { key: "a", label: "A", type: "text", public: false },
        ],
      }),
    ).toBe("invalid_extra_fields");
  });
});

describe("coerceExtraValues", () => {
  it("keeps declared keys with the right shape, in definition order", () => {
    const out = coerceExtraValues(DEFS, {
      cost: 12.5,
      notes: "line 1\n  line 2",
      subtitle: "  Hello  ",
      featured: false,
    });
    expect(out).toEqual({ featured: false, subtitle: "Hello", notes: "line 1\n  line 2", cost: 12.5 });
    expect(Object.keys(out)).toEqual(["featured", "subtitle", "notes", "cost"]);
  });

  it("drops undeclared keys, wrong types and empty values", () => {
    expect(
      coerceExtraValues(DEFS, {
        featured: "true",
        subtitle: "   ",
        notes: "",
        cost: Number.NaN,
        junk: "x",
      }),
    ).toEqual({});
    expect(coerceExtraValues(DEFS, { cost: "12", subtitle: 5, featured: null })).toEqual({});
    expect(coerceExtraValues(DEFS, { cost: Number.POSITIVE_INFINITY })).toEqual({});
  });

  it("caps text at 500 and multi-line text at 5000 characters", () => {
    const out = coerceExtraValues(DEFS, { subtitle: "a".repeat(600), notes: "b".repeat(6000) });
    expect((out.subtitle as string).length).toBe(500);
    expect((out.notes as string).length).toBe(5000);
  });

  it("returns an empty object for anything that is not a plain object", () => {
    for (const input of [null, undefined, "x", 3, ["a"]]) {
      expect(coerceExtraValues(DEFS, input)).toEqual({});
    }
  });
});

describe("withCoercedExtra", () => {
  it("leaves a body without extra untouched", () => {
    const body = { title: "A" };
    expect(withCoercedExtra(DEFS, body)).toBe(body);
  });

  it("drops extra entirely when the type has no definitions", () => {
    expect(withCoercedExtra([], { title: "A", extra: { a: 1 } })).toEqual({ title: "A" });
  });

  it("coerces extra and keeps an empty object so an update can clear old values", () => {
    expect(withCoercedExtra(DEFS, { extra: { cost: 3, junk: 1 } })).toEqual({ extra: { cost: 3 } });
    expect(withCoercedExtra(DEFS, { extra: { junk: 1 } })).toEqual({ extra: {} });
  });
});

describe("publicExtras", () => {
  const data = {
    title: "A",
    extra: { featured: true, subtitle: "Hi", notes: "secret", cost: 9, removed: "old" },
  };

  it("keeps only public keys; keys without a definition count as private", () => {
    expect(publicExtras(DEFS, data)).toEqual({ title: "A", extra: { featured: true, subtitle: "Hi" } });
  });

  it("omits extra when nothing public is left, and does not mutate the input", () => {
    const privateOnly = { title: "A", extra: { notes: "secret" } };
    expect(publicExtras(DEFS, privateOnly)).toEqual({ title: "A" });
    expect(publicExtras([], data)).toEqual({ title: "A" });
    expect(privateOnly.extra).toEqual({ notes: "secret" });
  });

  it("drops a malformed extra and passes data without extra through", () => {
    expect(publicExtras(DEFS, { title: "A", extra: "junk" })).toEqual({ title: "A" });
    const plain = { title: "A" };
    expect(publicExtras(DEFS, plain)).toBe(plain);
  });
});

describe("webhook payloads", () => {
  const fetchMock = vi.fn(async () => new Response("ok"));

  beforeEach(() => {
    settingsState.extraFields = { "blog.post": DEFS };
    settingsState.fail = false;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function sent(payload: unknown): Promise<{ payload: unknown }> {
    const handler = makeWebhookHandler("blog", "content:updated", [
      { action: "webhook", url: "https://hooks.example.com/in" },
    ]);
    await handler(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    return JSON.parse(String(init.body)) as { payload: unknown };
  }

  it("sends only public additional fields", async () => {
    const body = await sent({
      type: "blog.post",
      id: "p1",
      data: { title: "Hello", extra: { featured: true, notes: "secret", cost: 4 } },
    });
    expect(body.payload).toEqual({
      type: "blog.post",
      id: "p1",
      data: { title: "Hello", extra: { featured: true } },
    });
  });

  it("drops extra entirely when the definitions cannot be read", async () => {
    settingsState.fail = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = await sent({
      type: "blog.post",
      id: "p1",
      data: { title: "Hello", extra: { featured: true, notes: "secret" } },
    });
    spy.mockRestore();
    expect(body.payload).toEqual({ type: "blog.post", id: "p1", data: { title: "Hello" } });
  });

  it("passes other payload shapes through unchanged", async () => {
    const body = await sent({ orderId: "o1", extra: { notes: "kept" } });
    expect(body.payload).toEqual({ orderId: "o1", extra: { notes: "kept" } });
  });
});
