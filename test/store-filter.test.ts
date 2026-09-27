import { describe, expect, it } from "vitest";
import { getMessages } from "../src/lib/i18n";
import {
  NO_FILTER,
  categoryCounts,
  categoryKey,
  categoryLabel,
  detailParagraphs,
  filterEntries,
  isFiltered,
} from "../src/app/(admin)/admin/extensions/store-filter";
import type { RegistryEntry } from "../src/app/(admin)/admin/extensions/registry-types";
import { STORE_CATEGORIES } from "../src/ext/store-categories";

// 1.58.0:商店的分類導覽與篩選。

const zh = getMessages("zh-Hant");
const en = getMessages("en");
const tZh = (key: keyof typeof zh) => zh[key];
const tEn = (key: keyof typeof en) => en[key];

function entry(id: string, extra: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id,
    kind: "declarative",
    name: id,
    version: "1.0.0",
    coreApi: "^1.0.0",
    source: "https://registry.example.com",
    installed: false,
    installedVersion: null,
    compatible: true,
    ...extra,
  };
}

const ENTRIES = [
  entry("shop", { category: "commerce", tags: ["Orders", "付款"], name: "商店" }),
  entry("coupons", { category: "marketing", tags: ["orders"], installed: true, installedVersion: "1.0.0" }),
  entry("google-login", { category: "auth", description: "Sign in with Google" }),
  entry("mystery", { category: "games" }),
  entry("plain"),
  entry("pay", { category: "commerce" }),
];

describe("category labels", () => {
  it("every category has a label in both languages; unknown values read Other", () => {
    for (const category of STORE_CATEGORIES) {
      expect(categoryLabel(tZh, category)).not.toMatch(/registryBrowser/);
      expect(categoryLabel(tEn, category)).not.toMatch(/registryBrowser/);
    }
    expect(categoryLabel(tZh, "auth")).toBe("會員與登入");
    expect(categoryLabel(tEn, "auth")).toBe("Sign-in & members");
    expect(categoryLabel(tZh, "marketing")).toBe("營銷");
    expect(categoryLabel(tZh, "analytics")).toBe("數據");
    expect(categoryLabel(tZh, "games")).toBe("其他");
    expect(categoryLabel(tEn, undefined)).toBe("Other");
    expect(categoryLabel(tZh, "all")).toBe("全部");
    expect(categoryKey("constructor")).toBe("other");
  });
});

describe("category counts", () => {
  it("lists only categories that have plugins, in store order, with unknown and missing under Other", () => {
    expect(categoryCounts(ENTRIES)).toEqual([
      { key: "commerce", count: 2 },
      { key: "marketing", count: 1 },
      { key: "auth", count: 1 },
      { key: "other", count: 2 },
    ]);
    expect(categoryCounts([])).toEqual([]);
  });
});

describe("filtering", () => {
  const ids = (filter: Partial<typeof NO_FILTER>) =>
    filterEntries(ENTRIES, { ...NO_FILTER, ...filter }, (c) => categoryLabel(tZh, c)).map((e) => e.id);

  it("no filter keeps everything", () => {
    expect(ids({})).toEqual(ENTRIES.map((e) => e.id));
    expect(isFiltered(NO_FILTER)).toBe(false);
  });

  it("category, installed only and tag combine", () => {
    expect(ids({ category: "commerce" })).toEqual(["shop", "pay"]);
    expect(ids({ category: "other" })).toEqual(["mystery", "plain"]);
    expect(ids({ installedOnly: true })).toEqual(["coupons"]);
    expect(ids({ tag: "orders" })).toEqual(["shop", "coupons"]);
    expect(ids({ tag: "orders", category: "marketing" })).toEqual(["coupons"]);
    expect(isFiltered({ ...NO_FILTER, tag: "orders" })).toBe(true);
    expect(isFiltered({ ...NO_FILTER, query: "  " })).toBe(false);
  });

  it("search matches name, id, description, tags and the category's label", () => {
    expect(ids({ query: "商店" })).toEqual(["shop"]);
    expect(ids({ query: "google" })).toEqual(["google-login"]);
    expect(ids({ query: "付款" })).toEqual(["shop"]);
    expect(ids({ query: "電商" })).toEqual(["shop", "pay"]);
    expect(ids({ query: "會員" })).toEqual(["google-login"]);
  });
});

describe("detail paragraphs", () => {
  it("splits on blank lines and drops empty ones", () => {
    expect(detailParagraphs("One.\n\nTwo.\n  \n\nThree.")).toEqual(["One.", "Two.", "Three."]);
    expect(detailParagraphs(undefined)).toEqual([]);
    expect(detailParagraphs("  ")).toEqual([]);
  });
});
