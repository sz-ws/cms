import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/ext/dx/manifest";
import {
  IDENTITY_RE,
  installVerdict,
  isIdentity,
  listingVerdict,
  requirementState,
  requirementTargets,
  unmetRequirements,
  type InstalledPlugin,
} from "../src/ext/plugin-ref";
import { defineExtension } from "../src/ext/types";

// 1.50.0:插件的全域身分(identity)與插件之間的相依。純規則 + manifest schema。

const base = {
  kind: "declarative" as const,
  id: "reviews",
  name: "Reviews",
  version: "1.0.0",
  coreApi: "^1.50.0",
};

const installed = (plugins: InstalledPlugin[]) => new Map(plugins.map((p) => [p.id, p]));

describe("identity shape", () => {
  it.each(["sz-ws/catalog", "example.com/inventory", "acme/a1", "a-b.c-d/x-y"])("accepts %s", (value) => {
    expect(isIdentity(value)).toBe(true);
  });

  it.each([
    "catalog",
    "Sz-ws/catalog",
    "sz-ws//catalog",
    "sz--ws/catalog",
    "-sz/catalog",
    "sz./catalog",
    "sz-ws/1catalog",
    "sz-ws/catalog/extra",
    "sz ws/catalog",
    "a".repeat(90) + "/catalog",
  ])("rejects %s", (value) => {
    expect(isIdentity(value)).toBe(false);
  });

  it("is the same pattern the manifest schema uses", () => {
    expect(IDENTITY_RE.test("sz-ws/catalog")).toBe(true);
    expect(parseManifest({ ...base, identity: "not an identity" }).ok).toBe(false);
  });
});

describe("manifest identity and requiresExtensions", () => {
  it("accepts both fields on coreApi ^1.50.0", () => {
    const r = parseManifest({
      ...base,
      identity: "acme/reviews",
      requiresExtensions: [
        { id: "shop", reason: "Reviews belong to products." },
        { id: "catalog", identity: "sz-ws/catalog", optional: true, reason: { en: "Shows product names", "zh-Hant": "顯示商品名稱" } },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.manifest?.identity).toBe("acme/reviews");
    expect(r.manifest?.requiresExtensions).toHaveLength(2);
  });

  it("needs coreApi ^1.50.0 for either field", () => {
    const old = { ...base, coreApi: "^1.49.0" };
    expect(parseManifest({ ...old, identity: "acme/reviews" }).error).toMatch(/1\.50\.0/);
    expect(parseManifest({ ...old, requiresExtensions: [{ id: "shop" }] }).error).toMatch(/1\.50\.0/);
    expect(parseManifest(old).ok).toBe(true);
  });

  it("rejects requiring itself, by id or by identity", () => {
    expect(parseManifest({ ...base, requiresExtensions: [{ id: "reviews" }] }).error).toMatch(/itself/);
    expect(
      parseManifest({
        ...base,
        identity: "acme/reviews",
        requiresExtensions: [{ id: "reviews-v2", identity: "acme/reviews" }],
      }).error,
    ).toMatch(/itself/);
  });

  it("rejects the same id twice and unknown keys", () => {
    expect(parseManifest({ ...base, requiresExtensions: [{ id: "shop" }, { id: "shop" }] }).error).toMatch(/duplicate/);
    expect(parseManifest({ ...base, requiresExtensions: [{ id: "shop", version: "^1" }] }).ok).toBe(false);
    expect(parseManifest({ ...base, requiresExtensions: [{ id: "Shop" }] }).ok).toBe(false);
  });

  it("code extensions can carry an identity too, gated on coreApi", () => {
    expect(defineExtension({ id: "stock", name: "Stock", version: "1.0.0", coreApi: "^1.50.0", identity: "acme/stock" }).identity).toBe(
      "acme/stock",
    );
    expect(() => defineExtension({ id: "stock", name: "Stock", version: "1.0.0", coreApi: "^1.49.0", identity: "acme/stock" })).toThrow(
      /1\.50\.0/,
    );
    expect(() => defineExtension({ id: "stock", name: "Stock", version: "1.0.0", coreApi: "^1.50.0", identity: "stock" })).toThrow();
  });
});

describe("requirement state", () => {
  const shop: InstalledPlugin = { id: "shop", kind: "code", enabled: true, identity: null };

  it("met / disabled / missing", () => {
    expect(requirementState({ id: "shop" }, shop)).toBe("met");
    expect(requirementState({ id: "shop" }, { ...shop, enabled: false })).toBe("disabled");
    expect(requirementState({ id: "shop" }, undefined)).toBe("missing");
  });

  it("an installed plugin with a different identity does not count", () => {
    const other = { ...shop, identity: "other/shop" };
    expect(requirementState({ id: "shop", identity: "sz-ws/shop" }, other)).toBe("different");
    expect(requirementState({ id: "shop", identity: "sz-ws/shop" }, { ...other, identity: "sz-ws/shop" })).toBe("met");
  });

  it("an installed plugin without an identity is matched by id", () => {
    expect(requirementState({ id: "shop", identity: "sz-ws/shop" }, shop)).toBe("met");
  });

  it("unmetRequirements skips optional ones and reports the rest once", () => {
    const map = installed([shop, { id: "stock", kind: "declarative", enabled: false }]);
    expect(
      unmetRequirements(
        [
          { id: "shop" },
          { id: "stock" },
          { id: "points", optional: true },
          { id: "wallet" },
        ],
        map,
      ),
    ).toEqual([
      { id: "stock", state: "disabled" },
      { id: "wallet", state: "missing" },
    ]);
    expect(unmetRequirements(undefined, map)).toEqual([]);
  });

  it("requirementTargets compares identities when both have one, ids otherwise", () => {
    expect(requirementTargets({ id: "shop", identity: "a/shop" }, { id: "shop", identity: "b/shop" })).toBe(false);
    expect(requirementTargets({ id: "shop", identity: "a/shop" }, { id: "store", identity: "a/shop" })).toBe(true);
    expect(requirementTargets({ id: "shop" }, { id: "shop", identity: "b/shop" })).toBe(true);
  });
});

describe("installVerdict", () => {
  const A = "https://registry-a.test";
  const B = "https://registry-b.test";

  it("a fresh install is always fine", () => {
    expect(installVerdict(null, { identity: "x/y", source: A })).toEqual({ ok: true });
  });

  it("an installed identity is fixed, whatever the source", () => {
    const now = { identity: "acme/reviews", source: A };
    expect(installVerdict(now, { identity: "acme/reviews", source: A })).toEqual({ ok: true });
    expect(installVerdict(now, { identity: "other/reviews", source: A })).toEqual({
      ok: false,
      error: "identity_mismatch",
      installed: "acme/reviews",
      incoming: "other/reviews",
    });
    expect(installVerdict(now, { identity: null, source: A })).toMatchObject({ ok: false, error: "identity_mismatch", incoming: null });
    // 確認換來源不能拿來繞過 identity。
    expect(installVerdict(now, { identity: "other/reviews", source: A }, A).ok).toBe(false);
  });

  // 1.52.0:(來源, id) —— identity 相同、來源不同,也要管理員確認。
  it("the same identity from another source still needs the admin to confirm", () => {
    const now = { identity: "acme/reviews", source: A };
    expect(installVerdict(now, { identity: "acme/reviews", source: B })).toEqual({
      ok: false,
      error: "source_changed",
      installedSource: A,
    });
    expect(installVerdict(now, { identity: "acme/reviews", source: B }, B).ok).toBe(false);
    expect(installVerdict(now, { identity: "acme/reviews", source: B }, A)).toEqual({ ok: true });
  });

  it("an install from before identities is bound to its source until confirmed", () => {
    const legacy = { identity: null, source: A };
    expect(installVerdict(legacy, { identity: null, source: A })).toEqual({ ok: true });
    expect(installVerdict(legacy, { identity: "acme/reviews", source: A })).toEqual({ ok: true });
    expect(installVerdict(legacy, { identity: "acme/reviews", source: B })).toEqual({
      ok: false,
      error: "source_changed",
      installedSource: A,
    });
    expect(installVerdict(legacy, { identity: null, source: B }, B).ok).toBe(false);
    expect(installVerdict(legacy, { identity: null, source: B }, A)).toEqual({ ok: true });
  });

  it("does not compare sources for dev inline installs or rows without a source", () => {
    expect(installVerdict({ identity: null, source: A }, { identity: null, source: null })).toEqual({ ok: true });
    expect(installVerdict({ identity: null, source: null }, { identity: null, source: B })).toEqual({ ok: true });
  });
});

describe("listingVerdict", () => {
  const A = "https://registry-a.test";
  const B = "https://registry-b.test";

  it("compares identities only when both sides have one", () => {
    const now = { identity: "acme/reviews", source: A };
    expect(listingVerdict(now, { identity: "acme/reviews", source: A })).toEqual({ ok: true });
    expect(listingVerdict(now, { identity: "other/reviews", source: A })).toMatchObject({ ok: false, error: "identity_mismatch" });
  });

  // 1.52.0:商店以 (來源, id) 為準 —— 別的來源的同 identity 項目不是「已安裝」,沒有更新鈕。
  it("the same identity listed by another source is a source conflict", () => {
    const now = { identity: "acme/reviews", source: A };
    expect(listingVerdict(now, { identity: "acme/reviews", source: B })).toEqual({
      ok: false,
      error: "source_changed",
      installedSource: A,
    });
  });

  it("a listing without an identity falls back to the source, like an install from before identities", () => {
    const now = { identity: "acme/reviews", source: A };
    expect(listingVerdict(now, { identity: null, source: A })).toEqual({ ok: true });
    expect(listingVerdict(now, { identity: null, source: B })).toEqual({ ok: false, error: "source_changed", installedSource: A });
    expect(listingVerdict({ identity: "sz-ws/shop", source: null }, { identity: null, source: B })).toEqual({ ok: true });
  });
});
