import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fill, SlotRegistry, type SlotSource } from "../src/ext/slots";

// 側欄上「有事在等」的提示(1.77.0):插件從插槽 AdminAttention 報「哪一頁、現在有幾件」(src/ext/admin-attention.ts),
// 側欄問 GET /api/admin/attention。只問這個人打得開的頁;一個來源壞了、卡住,只少它那一筆。

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; role: "admin" | "editor" | "guest" }; access: Record<string, "view" | "edit"> | null },
  sources: [] as unknown[],
  runtimeLoads: 0,
}));

vi.mock("@/lib/auth", () => ({ getSessionAccess: async () => state.session }));
vi.mock("@/ext/loader", async () => {
  const { SlotRegistry: Registry } = await import("../src/ext/slots");
  return {
    getExtRuntime: async () => {
      state.runtimeLoads++;
      return { slots: new Registry(state.sources as SlotSource[]) };
    },
  };
});

import { AdminAttention, askAdminAttention, readAdminAttention, type AdminAttentionSource } from "../src/ext/admin-attention";
import { GET } from "../src/app/api/admin/attention/route";

const source = (href: string, count: AdminAttentionSource["count"]): AdminAttentionSource => ({ href, count });
const plugin = (extId: string, ...sources: unknown[]): SlotSource => ({
  extId,
  fills: [fill(AdminAttention, (list) => [...list, ...(sources as AdminAttentionSource[])])],
});
const everything = () => true;
const read = (sources: SlotSource[], canOpen: (href: string) => boolean = everything) =>
  readAdminAttention(new SlotRegistry(sources), canOpen);

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  state.session = null;
  state.sources = [];
  state.runtimeLoads = 0;
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("readAdminAttention", () => {
  it("沒有人報:空的", async () => {
    expect(await read([])).toEqual({});
  });

  it("每一頁現在有幾件(直接回數字或回 Promise 都可以)", async () => {
    const sources = [plugin("orders", source("/admin/ext/orders", () => 3)), plugin("repairs", source("/admin/ext/repairs/quotes", async () => 2))];
    expect(await read(sources)).toEqual({ "/admin/ext/orders": 3, "/admin/ext/repairs/quotes": 2 });
  });

  it("0 件的頁不出現在結果裡", async () => {
    expect(await read([plugin("a", source("/admin/ext/orders", () => 0), source("/admin/media", () => 1))])).toEqual({ "/admin/media": 1 });
  });

  it("寫壞的項目(不是物件、沒有 href、count 不是函式)丟掉,其他照常", async () => {
    const sources = [plugin("a", null, "/admin/ext/orders", { href: "/admin/ext/orders" }, { href: 42, count: () => 5 }, { href: "/admin/ext/orders", count: 5 }, source("/admin/media", () => 1))];
    expect(await read(sources)).toEqual({ "/admin/media": 1 });
  });

  it("整包被換成不是陣列的東西:當作沒有人報", async () => {
    const broken: SlotSource = { extId: "bad", fills: [fill(AdminAttention, () => "nope" as unknown as AdminAttentionSource[])] };
    expect(await read([broken])).toEqual({});
  });

  it("最多問 50 個來源,多的不問", async () => {
    const counts = Array.from({ length: 60 }, () => vi.fn(() => 1));
    const result = await read([plugin("many", ...counts.map((count, index) => source(`/admin/ext/p${index}`, count)))]);
    expect(Object.keys(result)).toHaveLength(50);
    expect(counts[49]).toHaveBeenCalledTimes(1);
    expect(counts[50]).not.toHaveBeenCalled();
  });

  it("50 個算的是真的要問的:這個人打不開的頁不佔名額", async () => {
    const sources = Array.from({ length: 60 }, (_, index) => source(`/admin/ext/p${index}`, () => 1));
    const result = await read([plugin("many", ...sources)], (href) => Number(href.slice("/admin/ext/p".length)) >= 20);
    expect(Object.keys(result)).toHaveLength(40);
    expect(result["/admin/ext/p59"]).toBe(1);
  });

  it.each([
    ["前台的頁", "/shop/orders"],
    ["只是開頭像後台", "/administrator"],
    ["站外網址", "https://evil.test/admin/ext/orders"],
    ["少了開頭的斜線", "admin/ext/orders"],
    ["空字串", ""],
  ])("只收後台的頁(%s):不問", async (_name, href) => {
    const count = vi.fn(() => 4);
    expect(await read([plugin("a", source(href, count))])).toEqual({});
    expect(count).not.toHaveBeenCalled();
  });

  it("儀表板(/admin)本身也算後台的頁", async () => {
    expect(await read([plugin("a", source("/admin", () => 1))])).toEqual({ "/admin": 1 });
  });

  it("這個人打不開的頁:連問都不問", async () => {
    const hidden = vi.fn(() => 7);
    const shown = vi.fn(() => 2);
    const canOpen = vi.fn((href: string) => href === "/admin/ext/orders");
    const sources = [plugin("a", source("/admin/ext/payouts", hidden), source("/admin/ext/orders", shown))];
    expect(await read(sources, canOpen)).toEqual({ "/admin/ext/orders": 2 });
    expect(hidden).not.toHaveBeenCalled();
    expect(shown).toHaveBeenCalledTimes(1);
    expect(canOpen).toHaveBeenCalledWith("/admin/ext/payouts");
  });

  it("來源一起問,不是一個等一個", async () => {
    const release: (() => void)[] = [];
    const slow = (value: number) => vi.fn(() => new Promise<number>((resolve) => release.push(() => resolve(value))));
    const first = slow(1);
    const second = slow(2);
    const pending = read([plugin("a", source("/admin/ext/a", first), source("/admin/ext/b", second))]);
    await Promise.resolve();
    await Promise.resolve();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    release.forEach((done) => done());
    expect(await pending).toEqual({ "/admin/ext/a": 1, "/admin/ext/b": 2 });
  });

  it("問的時候丟例外(同步或非同步):那一頁當作 0,記一筆,其他照常", async () => {
    const boom = new Error("no such table");
    const sources = [
      plugin(
        "a",
        source("/admin/ext/thrown", () => {
          throw boom;
        }),
        source("/admin/ext/rejected", async () => {
          throw boom;
        }),
        source("/admin/ext/orders", () => 3),
      ),
    ];
    expect(await read(sources)).toEqual({ "/admin/ext/orders": 3 });
    expect(errors).toHaveBeenCalledTimes(2);
    expect(errors.mock.calls.map((call: unknown[]) => call[1])).toEqual(["/admin/ext/thrown", "/admin/ext/rejected"]);
    expect(String(errors.mock.calls[0][0])).toContain("[admin-attention]");
    expect(errors.mock.calls[0][2]).toBe(boom);
  });

  it("問不到的頁另外列出來(unknown):側欄知道那一頁不是「沒有事」,是「這次不知道」", async () => {
    const sources = [
      plugin(
        "a",
        source("/admin/ext/broken", () => { throw new Error("database is busy"); }),
        source("/admin/ext/orders", () => 3),
        // 同一頁兩個來源,一個答了一個沒答:答了的照算,這一頁仍然列在 unknown。
        source("/admin/ext/mixed", () => 2),
        source("/admin/ext/mixed", async () => { throw new Error("database is busy"); }),
      ),
    ];
    expect(await askAdminAttention(new SlotRegistry(sources), everything)).toEqual({ counts: { "/admin/ext/orders": 3, "/admin/ext/mixed": 2 }, unknown: ["/admin/ext/broken", "/admin/ext/mixed"] });
    expect(await askAdminAttention(new SlotRegistry([plugin("a", source("/admin/ext/orders", () => 3))]), everything)).toEqual({ counts: { "/admin/ext/orders": 3 }, unknown: [] });
  });

  it("一個項目連讀都會丟例外(壞掉的 getter):丟掉它,其他照常", async () => {
    const trap = Object.defineProperty({}, "href", { get() { throw new Error("broken getter"); } });
    expect(await read([plugin("a", trap, source("/admin/ext/orders", () => 3))])).toEqual({ "/admin/ext/orders": 3 });
  });

  it("儀表板帶著篩選(/admin?range=7d)一樣算後台的頁", async () => {
    expect(await read([plugin("a", source("/admin?range=7d", () => 2), source("/administrator?x=1", () => 5))])).toEqual({ "/admin?range=7d": 2 });
  });

  it("問了一直沒有回答(卡住):等 2 秒就當作 0,記一筆,其他照常", async () => {
    vi.useFakeTimers();
    try {
      const stuck = source("/admin/ext/stuck", () => new Promise<number>(() => undefined));
      const pending = read([plugin("a", stuck, source("/admin/ext/orders", async () => 3))]);
      await vi.advanceTimersByTimeAsync(1_999);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ "/admin/ext/orders": 3 });
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0][1]).toBe("/admin/ext/stuck");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["NaN", Number.NaN],
    ["無限大", Number.POSITIVE_INFINITY],
    ["負數", -3],
    ["不到 1", 0.9],
    ["字串", "3"],
    ["null", null],
    ["物件", { count: 3 }],
  ])("回的不是 1 以上的有限數字(%s):當作 0", async (_name, value) => {
    expect(await read([plugin("a", source("/admin/ext/orders", () => value as number))])).toEqual({});
    expect(errors).not.toHaveBeenCalled();
  });

  it("小數捨去,最多 9999", async () => {
    const sources = [plugin("a", source("/admin/ext/a", () => 3.9), source("/admin/ext/b", () => 1_000_000))];
    expect(await read(sources)).toEqual({ "/admin/ext/a": 3, "/admin/ext/b": 9999 });
  });

  it("同一頁有好幾個來源:加起來(加完一樣最多 9999)", async () => {
    const sources = [
      plugin("a", source("/admin/ext/orders", () => 2), source("/admin/ext/big", () => 9000)),
      plugin("b", source("/admin/ext/orders", async () => 5), source("/admin/ext/big", () => 9000)),
    ];
    expect(await read(sources)).toEqual({ "/admin/ext/orders": 7, "/admin/ext/big": 9999 });
  });
});

describe("GET /api/admin/attention", () => {
  const orders = vi.fn(() => 3);
  const payouts = vi.fn(async () => 2);
  const dashboard = vi.fn(() => 1);
  const all = () => [plugin("a", source("/admin/ext/orders", orders), source("/admin/ext/payouts", payouts), source("/admin", dashboard))];

  beforeEach(() => {
    orders.mockClear();
    payouts.mockClear();
    dashboard.mockClear();
    state.sources = all();
  });

  it("沒登入:401,不問任何來源", async () => {
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(state.runtimeLoads).toBe(0);
    expect(orders).not.toHaveBeenCalled();
  });

  it("有來源這次問不到:那一頁列在 unknown,其他照常", async () => {
    state.sources = [plugin("a", source("/admin/ext/orders", orders), source("/admin/ext/payouts", async () => { throw new Error("database is busy"); }))];
    state.session = { user: { id: "u1", role: "admin" }, access: null };
    expect(await (await GET()).json()).toEqual({ counts: { "/admin/ext/orders": 3 }, unknown: ["/admin/ext/payouts"] });
  });

  it("自訂角色只有子頁的權限:上層那一頁的件數不給,反過來也是", async () => {
    state.sources = [plugin("a", source("/admin/ext/orders", orders), source("/admin/ext/orders/refunds", payouts))];
    state.session = { user: { id: "u4", role: "editor" }, access: { "/admin/ext/orders/refunds": "view" } };
    expect(await (await GET()).json()).toEqual({ counts: { "/admin/ext/orders/refunds": 2 } });
    expect(orders).not.toHaveBeenCalled();
    state.session = { user: { id: "u5", role: "editor" }, access: { "/admin/ext/orders": "view" } };
    payouts.mockClear();
    expect(await (await GET()).json()).toEqual({ counts: { "/admin/ext/orders": 3 } });
    expect(payouts).not.toHaveBeenCalled();
  });

  it("不認得的角色(資料壞了):什麼都不問", async () => {
    state.session = { user: { id: "u9", role: "owner" as never }, access: null };
    expect(await (await GET()).json()).toEqual({ counts: {} });
    expect(orders).not.toHaveBeenCalled();
    expect(dashboard).not.toHaveBeenCalled();
  });

  it("管理員:每一頁都問;回應不進任何快取", async () => {
    state.session = { user: { id: "u1", role: "admin" }, access: null };
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ counts: { "/admin/ext/orders": 3, "/admin/ext/payouts": 2, "/admin": 1 } });
  });

  it("訪客(一般會員):空的,不問任何來源", async () => {
    state.session = { user: { id: "u2", role: "guest" }, access: null };
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ counts: {} });
    expect(state.runtimeLoads).toBe(0);
    expect(orders).not.toHaveBeenCalled();
    expect(dashboard).not.toHaveBeenCalled();
  });

  it("工作人員(editor):只問儀表板", async () => {
    state.session = { user: { id: "u3", role: "editor" }, access: null };
    expect(await (await GET()).json()).toEqual({ counts: { "/admin": 1 } });
    expect(orders).not.toHaveBeenCalled();
    expect(payouts).not.toHaveBeenCalled();
  });

  it("自訂角色:只問它看得到的頁", async () => {
    state.session = { user: { id: "u4", role: "editor" }, access: { "/admin/ext/orders": "view" } };
    expect(await (await GET()).json()).toEqual({ counts: { "/admin/ext/orders": 3 } });
    expect(payouts).not.toHaveBeenCalled();
    expect(dashboard).not.toHaveBeenCalled();
  });

  it("來源報的頁帶著篩選(?status=…):權限看那一頁本身,結果照它報的網址", async () => {
    state.sources = [plugin("a", source("/admin/ext/orders?status=paid", orders), source("/admin/ext/payouts?tab=open", payouts))];
    state.session = { user: { id: "u4", role: "editor" }, access: { "/admin/ext/orders": "view" } };
    expect(await (await GET()).json()).toEqual({ counts: { "/admin/ext/orders?status=paid": 3 } });
    expect(payouts).not.toHaveBeenCalled();
  });
});
