import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { dropCached, readCached, writeCached } from "../src/lib/client-cache";

// 1.41.0:插件工作區的記憶體快取(lib/client-cache.ts)。測試環境沒有 window,
// 先假裝在瀏覽器裡;最後一個測試拿掉 window,確認 server 上讀寫都不作用。

const g = globalThis as { window?: unknown };

beforeEach(() => {
  g.window = globalThis;
  dropCached();
});
afterAll(() => {
  delete g.window;
});

describe("client-cache", () => {
  it("存了讀得到,沒存的是 undefined", () => {
    writeCached("shop-operations:admin:1", { orders: [1] });
    expect(readCached("shop-operations:admin:1")).toEqual({ orders: [1] });
    expect(readCached("shop-operations:admin:2")).toBeUndefined();
  });

  it("最多 40 筆,最早寫的先丟", () => {
    for (let i = 0; i < 45; i++) writeCached(`k${i}`, i);
    expect(readCached("k0")).toBeUndefined();
    expect(readCached("k4")).toBeUndefined();
    expect(readCached("k5")).toBe(5);
    expect(readCached("k44")).toBe(44);
  });

  it("dropCached 依前綴清掉", () => {
    writeCached("dealer:admin:1", 1);
    writeCached("referral:admin", 2);
    dropCached("dealer:");
    expect(readCached("dealer:admin:1")).toBeUndefined();
    expect(readCached("referral:admin")).toBe(2);
  });

  it("server 上(沒有 window)讀寫都不作用 —— 不能讓資料跨請求", () => {
    delete g.window;
    writeCached("secret", { email: "a@example.com" });
    g.window = globalThis;
    expect(readCached("secret")).toBeUndefined();
    writeCached("x", 1);
    delete g.window;
    expect(readCached("x")).toBeUndefined();
  });
});
