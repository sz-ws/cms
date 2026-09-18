import { describe, it, expect } from "vitest";
import {
  dayInputToMs,
  hasRecordSearch,
  msToDayInput,
  parseRecordSearch,
  recordSearchClauses,
  recordSearchParams,
} from "../src/ext/record-search";
import { ORDER_SEARCH_FIELDS } from "../src/ext/commerce-kit/orders";

// core 的資料表搜尋層(1.40.0):參數解析與 SQL 片段。實際查詢在
// commerce-orders.test.ts(訂單)與 search-sources.test.ts(⌘K 來源)。

const orderSearchClauses = (search: Parameters<typeof recordSearchClauses>[1], alias?: string) =>
  recordSearchClauses(ORDER_SEARCH_FIELDS, search, alias);

describe("parseRecordSearch / recordSearchParams", () => {
  it("來回一致", () => {
    const search = { q: "王", from: 1788220800000, to: 1788307200000 };
    expect(parseRecordSearch(recordSearchParams(search))).toEqual(search);
  });

  it("讀 q / from / to,去掉空白", () => {
    const params = new URLSearchParams({ q: "  王小明 ", from: "1788220800000", to: "1788307200000" });
    expect(parseRecordSearch(params)).toEqual({ q: "王小明", from: 1788220800000, to: 1788307200000 });
  });

  it("忽略不合法的期間與空查詢", () => {
    const params = new URLSearchParams({ q: "   ", from: "yesterday", to: "1700" });
    expect(parseRecordSearch(params)).toEqual({});
    expect(hasRecordSearch(parseRecordSearch(params))).toBe(false);
  });

  it("查詢字串最多 100 字", () => {
    expect(parseRecordSearch(new URLSearchParams({ q: "x".repeat(300) })).q).toHaveLength(100);
  });
});

describe("orderSearchClauses", () => {
  it("沒有條件就沒有子句", () => {
    expect(orderSearchClauses({})).toEqual({ clauses: [], args: [] });
  });

  it("帶別名,參數順序對應 ?", () => {
    const { clauses, args } = orderSearchClauses({ q: "0912-345", from: 1, to: 2 }, "o");
    expect(clauses).toHaveLength(3);
    expect(clauses[0]).toContain("o.customer_phone");
    expect(clauses.join(" ").split("?").length - 1).toBe(args.length);
    expect(args).toEqual(["%0912-345%", "%0912-345%", "%0912-345%", "%0912345%", 1, 2]);
  });

  it("跳脫 LIKE 萬用字元", () => {
    expect(orderSearchClauses({ q: "50%_off" }).args[0]).toBe("%50\\%\\_off%");
  });
});

describe("dayInputToMs / msToDayInput", () => {
  it("一天的起點與隔天起點,來回一致", () => {
    const from = dayInputToMs("2026-09-01")!;
    const to = dayInputToMs("2026-09-18", true)!;
    expect(new Date(from).getDate()).toBe(1);
    expect(new Date(to).getDate()).toBe(19);
    expect(msToDayInput(from)).toBe("2026-09-01");
    expect(msToDayInput(to, true)).toBe("2026-09-18");
  });

  it("格式不對回 undefined,空值回空字串", () => {
    expect(dayInputToMs("9/1")).toBeUndefined();
    expect(msToDayInput(undefined)).toBe("");
  });
});

describe("recordSearchClauses 宣告檢查", () => {
  it("沒宣告 date 時忽略期間", () => {
    expect(recordSearchClauses({ text: ["name"] }, { from: 1, to: 2 })).toEqual({ clauses: [], args: [] });
  });

  it("欄位名不是識別字就拒絕(不拼進 SQL)", () => {
    expect(() => recordSearchClauses({ text: ["name; DROP TABLE users"] }, { q: "x" })).toThrow(/invalid column/);
    expect(() => recordSearchClauses({ text: ["name"] }, { q: "x" }, "o o")).toThrow(/invalid alias/);
  });
});
