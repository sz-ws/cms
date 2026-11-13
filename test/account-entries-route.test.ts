import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fill, type SlotSource } from "../src/ext/slots";

// 「我的帳戶」的項目給瀏覽器問(2.x):GET /api/account/entries?locale=<locale>。存起來的公開頁(例如站台的會員總覽)
// 在畫面出現之後才問登入的人有哪些帳戶項目;項目與狀態跟 accountEntriesFor()(src/ext/account-entries.ts)一樣。

const state = vi.hoisted(() => ({
  user: null as null | { id: string; role: "admin" | "editor" | "guest" },
  sources: [] as unknown[],
  siteLocale: "zh-Hant" as "en" | "zh-Hant",
  runtimeLoads: 0,
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: async () => state.user }));
vi.mock("@/lib/i18n/server", () => ({ getLocale: async () => state.siteLocale }));
vi.mock("@/ext/loader", async () => {
  const { SlotRegistry: Registry } = await import("../src/ext/slots");
  return {
    getExtRuntime: async () => {
      state.runtimeLoads++;
      return { slots: new Registry(state.sources as SlotSource[]) };
    },
  };
});

import { AccountEntries, type AccountEntry } from "../src/ext/account-entries";
import { GET } from "../src/app/api/account/entries/route";

const plugin = (extId: string, ...entries: AccountEntry[]): SlotSource => ({
  extId,
  fills: [fill(AccountEntries, (list) => [...list, ...entries])],
});
const orders: AccountEntry = {
  key: "orders",
  href: "/shop/orders",
  label: { en: "My orders", "zh-Hant": "我的訂單" },
  note: async (person, locale) => (locale === "en" ? `orders of ${person.id}` : `${person.id} 的訂單`),
};
const staffOnly: AccountEntry = { key: "staff-desk", href: "/desk", label: "Desk", note: async (person) => (person.role === "guest" ? null : "open") };

const get = (query = "") => GET(new Request(`https://site.example/api/account/entries${query}`));

beforeEach(() => {
  state.user = null;
  state.sources = [plugin("orders-plugin", orders), plugin("desk-plugin", staffOnly)];
  state.siteLocale = "zh-Hant";
  state.runtimeLoads = 0;
});

afterEach(() => vi.restoreAllMocks());

describe("GET /api/account/entries", () => {
  it("signed out: 401 in the usual error shape, nothing asked, not cached", async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(state.runtimeLoads).toBe(0);
  });

  it("signed in: this person's entries in the site's default language, in fill order", async () => {
    state.user = { id: "u1", role: "guest" };
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ entries: [{ key: "orders", href: "/shop/orders", label: "我的訂單", note: "u1 的訂單" }] });
  });

  it("entries a person cannot use are left out; staff see theirs", async () => {
    state.user = { id: "s1", role: "editor" };
    const body = (await (await get()).json()) as { entries: { key: string }[] };
    expect(body.entries.map((entry) => entry.key)).toEqual(["orders", "staff-desk"]);
  });

  it("?locale= picks one of the site's languages", async () => {
    state.user = { id: "u1", role: "guest" };
    expect(await (await get("?locale=en")).json()).toEqual({ entries: [{ key: "orders", href: "/shop/orders", label: "My orders", note: "orders of u1" }] });
    state.siteLocale = "en";
    expect(((await (await get("?locale=zh-Hant")).json()) as { entries: { label: string }[] }).entries[0].label).toBe("我的訂單");
  });

  it("an unknown locale is a 400, not a silent fallback", async () => {
    state.user = { id: "u1", role: "guest" };
    const res = await get("?locale=fr");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_locale" });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
