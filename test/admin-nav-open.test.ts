import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  ADMIN_NAV_STORAGE_KEY,
  parseNavOpen,
  resetNavOpenForTest,
  setNavOpen,
} from "../src/components/admin/nav-open-store";

// 1.43.0:側欄開合記在 localStorage(components/admin/nav-open-store.ts)。
// 測試環境沒有 window / localStorage,這裡放一個最小的假的。

const g = globalThis as { window?: unknown };
let stored = new Map<string, string>();
const fakeStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
};

beforeEach(() => {
  stored = new Map();
  g.window = { localStorage: fakeStorage, addEventListener() {}, removeEventListener() {} };
  resetNavOpenForTest();
});
afterAll(() => {
  delete g.window;
});

const saved = () => parseNavOpen(stored.get(ADMIN_NAV_STORAGE_KEY) ?? null);

describe("nav-open-store", () => {
  it("點過的分區與資料夾寫進 localStorage", () => {
    setNavOpen("groups", "shop", true);
    setNavOpen("folders", "/admin/ext/dealer", false);
    expect(saved()).toEqual({ groups: { shop: true }, folders: { "/admin/ext/dealer": false } });
  });

  it("重新載入(模組快取清掉)後讀回同樣的狀態", () => {
    setNavOpen("groups", "content", false);
    resetNavOpenForTest();
    setNavOpen("groups", "shop", true);
    expect(saved().groups).toEqual({ content: false, shop: true });
  });

  it("壞掉的資料當沒記過;不是布林的值丟掉", () => {
    expect(parseNavOpen("not json")).toEqual({ groups: {}, folders: {} });
    expect(parseNavOpen('{"groups":{"a":true,"b":"yes"},"folders":[]}')).toEqual({
      groups: { a: true },
      folders: {},
    });
  });

  it("每一類最多記 100 筆,最早點的先丟", () => {
    for (let i = 0; i < 105; i++) setNavOpen("folders", `/admin/f${i}`, true);
    const folders = saved().folders;
    expect(Object.keys(folders)).toHaveLength(100);
    expect(folders["/admin/f0"]).toBeUndefined();
    expect(folders["/admin/f104"]).toBe(true);
  });

  it("localStorage 不能用時不會丟錯", () => {
    g.window = {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    };
    resetNavOpenForTest();
    expect(() => setNavOpen("groups", "shop", true)).not.toThrow();
  });
});
