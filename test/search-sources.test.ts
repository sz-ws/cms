import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { activeSearchSources, searchRecordSources } from "../src/ext/search-sources";
import { defineExtension } from "../src/ext/types";
import type { AdminPageSearch } from "../src/ext/record-search";

// 1.40.0:插件頁的搜尋宣告(adminPages[].search)與由它衍生的 ⌘K 來源
// (ext/search-sources.ts)。

const d1 = () => (env as { DB: D1Database }).DB;
const TABLE = "ext_srctest_orders";

const ORDERS: AdminPageSearch = {
  placeholder: "姓名、電話或訂單編號",
  fields: { text: ["order_no", "customer_name"], phone: ["customer_phone"], date: "created_at" },
  global: {
    id: "orders",
    label: { en: "Orders", "zh-Hant": "訂單" },
    table: TABLE,
    key: "order_no",
    title: "customer_name",
    subtitle: ["order_no", "customer_phone"],
  },
};
const withGlobal = (patch: Partial<NonNullable<AdminPageSearch["global"]>>): AdminPageSearch => ({
  ...ORDERS,
  global: { ...ORDERS.global!, ...patch },
});
const page = (search: AdminPageSearch, slug = "") => ({ slug, search });

const resolve = (value: NonNullable<AdminPageSearch["global"]>["label"]) =>
  typeof value === "string" ? value : (value["zh-Hant"] ?? value.en ?? "");

beforeAll(async () => {
  await d1().exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (order_no TEXT PRIMARY KEY, customer_name TEXT NOT NULL, customer_phone TEXT, created_at INTEGER NOT NULL);`,
  );
  await d1().exec(`DELETE FROM ${TABLE};`);
  await d1()
    .prepare(`INSERT INTO ${TABLE} VALUES (?, ?, ?, ?), (?, ?, ?, ?)`)
    .bind("SA 1", "王小明", "0912-345-678", 1, "SA2", "陳美玲", null, 2)
    .run();
});

describe("activeSearchSources", () => {
  it("接管同一張表的來源取代原本的,⌘K 不會出現兩次", () => {
    const active = activeSearchSources([
      { id: "shop", adminPages: [page(ORDERS)] },
      { id: "shop-operations", adminPages: [page(withGlobal({ replaces: "shop:orders" }))] },
    ]);
    expect(active.map((entry) => entry.ref)).toEqual(["shop-operations:orders"]);
    expect(active[0].pageHref).toBe("/admin/ext/shop-operations");
  });

  it("被取代的來源所屬插件停用時,原本的照常生效", () => {
    expect(activeSearchSources([{ id: "shop", adminPages: [page(ORDERS)] }]).map((e) => e.ref)).toEqual(["shop:orders"]);
  });

  it("只有頁面搜尋、沒有 global 的頁不進 ⌘K", () => {
    expect(activeSearchSources([{ id: "shop", adminPages: [page({ ...ORDERS, global: undefined })] }])).toEqual([]);
  });
});

describe("searchRecordSources", () => {
  const sources = activeSearchSources([{ id: "shop", adminPages: [page(ORDERS, "orders")] }]);

  it("依宣告的欄位搜,帶出標題、副標,連回宣告的頁面並打開那一筆", async () => {
    const hits = await searchRecordSources(d1(), sources, "0912345", resolve);
    expect(hits).toEqual([
      {
        kind: "record",
        id: "SA 1",
        typeKey: "shop:orders",
        typeLabel: "訂單",
        title: "王小明",
        snippet: "SA 1 · 0912-345-678",
        editHref: "/admin/ext/shop/orders?q=SA+1&open=SA+1",
      },
    ]);
  });

  it("空值不進副標;新的在前", async () => {
    const hits = await searchRecordSources(d1(), sources, "SA", resolve);
    expect(hits.map((hit) => hit.id)).toEqual(["SA2", "SA 1"]);
    expect(hits[0].snippet).toBe("SA2");
  });

  it("一個來源壞掉只略過那一個", async () => {
    const broken = activeSearchSources([
      { id: "gone", adminPages: [page(withGlobal({ table: "ext_missing_table" }))] },
      { id: "shop", adminPages: [page(ORDERS)] },
    ]);
    const hits = await searchRecordSources(d1(), broken, "王", resolve);
    expect(hits.map((hit) => hit.typeKey)).toEqual(["shop:orders"]);
  });
});

describe("defineExtension 驗證 adminPages[].search", () => {
  const base = { id: "demo", name: "Demo", version: "0.1.0", coreApi: "^1.40.0" };
  const Page = () => null;
  const ext = (search: AdminPageSearch, coreApi = "^1.40.0") =>
    defineExtension({ ...base, coreApi, adminPages: [{ slug: "", title: "訂單", component: Page, search }] });

  it("合法宣告通過,只有頁面搜尋(沒有 global)也可以", () => {
    expect(() => ext(ORDERS)).not.toThrow();
    expect(() => ext({ ...ORDERS, global: undefined })).not.toThrow();
  });

  it("core 的表、非識別字欄位都擋", () => {
    expect(() => ext(withGlobal({ table: "users" }))).toThrow();
    expect(() => ext(withGlobal({ title: "name) --" }))).toThrow();
    expect(() => ext({ ...ORDERS, fields: { text: ["name; DROP TABLE x"] } })).toThrow();
    expect(() => ext({ ...ORDERS, fields: { text: [] } })).toThrow();
  });

  it("需要 coreApi 1.40.0 以上", () => {
    expect(() => ext(ORDERS, "^1.39.0")).toThrow(/1\.40\.0/);
  });
});
