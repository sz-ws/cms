import { describe, it, expect, vi, afterEach } from "vitest";

// 1.50.0:registry.json 的 identity 與 requiresExtensions 解析。程式碼插件的索引多半
// 直接抄 Extension.requiresExtensions(字串陣列),宣告式的是物件陣列;兩種都收,
// 不合規的值丟掉而不是讓整個來源失敗。

vi.mock("@/lib/settings", () => ({
  getSetting: async () => ["https://registry.test"],
  getRegistryTokenMap: async () => ({}),
}));

import { fetchRegistryIndex } from "../src/lib/registry-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

function serve(json: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } })),
  );
}

const base = { name: "X", version: "1.0.0", coreApi: "^1.50.0" };

describe("registry index parsing", () => {
  it("reads identity and both shapes of requiresExtensions", async () => {
    serve({
      extensions: [
        { ...base, id: "bundles", kind: "code", identity: "example.com/bundles", requiresExtensions: ["stock", "points", "Not An Id", 3] },
        {
          ...base,
          id: "reviews",
          kind: "declarative",
          identity: "not valid",
          requiresExtensions: [
            { id: "shop", identity: "sz-ws/shop", reason: { "zh-Hant": "評論掛在商品上", fr: "x" } },
            { id: "loyalty", optional: true, reason: "Rewards", extra: true },
            { id: "shop" },
            { identity: "sz-ws/nothing" },
          ],
        },
        { ...base, id: "plain", kind: "declarative" },
      ],
    });
    const { entries, errors } = await fetchRegistryIndex();
    expect(errors).toEqual([]);
    const [bundles, reviews, plain] = entries;
    expect(bundles.identity).toBe("example.com/bundles");
    expect(bundles.requiresExtensions).toEqual([
      { id: "stock", identity: undefined, optional: undefined, reason: undefined },
      { id: "points", identity: undefined, optional: undefined, reason: undefined },
    ]);
    expect(reviews.identity).toBeUndefined();
    expect(reviews.requiresExtensions).toEqual([
      { id: "shop", identity: "sz-ws/shop", optional: undefined, reason: { "zh-Hant": "評論掛在商品上" } },
      { id: "loyalty", identity: undefined, optional: true, reason: "Rewards" },
    ]);
    expect(plain.requiresExtensions).toBeUndefined();
  });
});
