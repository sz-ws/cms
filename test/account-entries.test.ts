import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountEntries, accountEntriesFor, type AccountEntry } from "../src/ext/account-entries";
import { isSitePath } from "../src/ext/site-path";
import { SlotRegistry, fill, type SlotSource } from "../src/ext/slots";

// 「我的帳戶」那一區的項目(src/ext/account-entries.ts,core 1.74.0):有帳戶頁的插件各加一項
// (訂單、經銷專區、推廣中心…),畫帳戶總覽的那一方(站台的會員中心、會員插件)讀出來畫。
// 讀的時候順便問每一項「這個人現在的狀態」;用不到的(回 null)不出現,壞掉的不拖累其他項。

const person = { id: "u1", role: "guest" as const };
const entry = (key: string, note: AccountEntry["note"] = async () => `${key} 的狀態`, over: Partial<AccountEntry> = {}): AccountEntry => ({ key, href: `/${key}`, label: key.toUpperCase(), note, ...over });
const plugin = (extId: string, ...entries: unknown[]): SlotSource => ({ extId, fills: [fill(AccountEntries, (list) => [...list, ...(entries as AccountEntry[])])] });
const read = (...sources: SlotSource[]) => accountEntriesFor(new SlotRegistry(sources), person, "zh-Hant");

afterEach(() => vi.restoreAllMocks());

describe("accountEntriesFor", () => {
  it("沒有人加:空的", async () => {
    expect(await read()).toEqual([]);
  });

  it("照插件填的先後列出來,每一項帶著這個人現在的狀態", async () => {
    expect(await read(plugin("shop-operations", entry("orders")), plugin("dealer", entry("dealer")))).toEqual([
      { key: "orders", href: "/orders", label: "ORDERS", note: "orders 的狀態" },
      { key: "dealer", href: "/dealer", label: "DEALER", note: "dealer 的狀態" },
    ]);
  });

  it("把這個人與語言交給每一項去問", async () => {
    const note = vi.fn(async () => "ok");
    await read(plugin("a", entry("orders", note)));
    expect(note).toHaveBeenCalledWith(person, "zh-Hant");
  });

  it("有翻譯的名字照語言挑;只有一種語言的照給的", async () => {
    const source = plugin("a", entry("profile", undefined, { label: { en: "Your details", "zh-Hant": "會員資料" } }), entry("orders", undefined, { label: "我的訂單" }));
    expect((await accountEntriesFor(new SlotRegistry([source]), person, "zh-Hant")).map((item) => item.label)).toEqual(["會員資料", "我的訂單"]);
    expect((await accountEntriesFor(new SlotRegistry([source]), person, "en")).map((item) => item.label)).toEqual(["Your details", "我的訂單"]);
  });

  it("這個人用不到的那一項(狀態是 null 或空的)不出現", async () => {
    expect((await read(plugin("a", entry("orders"), entry("dealer", async () => null), entry("referral", async () => "  ")))).map((item) => item.key)).toEqual(["orders"]);
  });

  it("一項問狀態時壞了:記下來、少它一個,其他照常", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = entry("dealer", async () => {
      throw new Error("no such table");
    });
    expect((await read(plugin("a", entry("orders"), broken, entry("referral")))).map((item) => item.key)).toEqual(["orders", "referral"]);
    expect(String(errors.mock.calls[0][0])).toContain("dealer");
  });

  it("同一個代號後填的蓋掉先填的,位置照先來的", async () => {
    const site: SlotSource = { extId: "site", layer: "site", fills: [fill(AccountEntries, (list) => [...list, entry("orders", async () => "站台的說法", { label: "我的訂單" })])] };
    expect(await read(site, plugin("a", entry("orders"), entry("dealer")))).toEqual([
      { key: "orders", href: "/orders", label: "我的訂單", note: "站台的說法" },
      { key: "dealer", href: "/dealer", label: "DEALER", note: "dealer 的狀態" },
    ]);
  });

  it.each([
    ["不是物件", "orders"],
    ["沒有代號", { href: "/x", label: "X", note: async () => "x" }],
    ["代號不是小寫英數", entry("My Orders")],
    ["網址不是站內路徑", entry("orders", undefined, { href: "https://elsewhere.test/orders" })],
    ["沒有名字", entry("orders", undefined, { label: "" })],
    ["名字的翻譯是空的", entry("orders", undefined, { label: { en: "" } })],
    ["狀態不是函式", { key: "orders", href: "/orders", label: "X", note: "always" }],
  ])("寫壞的項目(%s)丟掉並記一筆,其他照常", async (_name, bad) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await read(plugin("a", bad, entry("dealer")))).map((item) => item.key)).toEqual(["dealer"]);
    expect(errors).toHaveBeenCalledOnce();
    expect(String(errors.mock.calls[0][0])).toContain("account-entries");
  });

  it("畫的那一方沒看過、彼此也不認識的兩項:照填的先後", async () => {
    expect((await read(plugin("a", entry("wallet")), plugin("b", entry("coupons")))).map((item) => item.key)).toEqual(["wallet", "coupons"]);
  });

  it("填的函式回的不是陣列:當作沒有人加", async () => {
    const wrong: SlotSource = { extId: "a", fills: [fill(AccountEntries, () => "nope" as unknown as AccountEntry[])] };
    expect(await read(wrong)).toEqual([]);
  });
});

describe("isSitePath", () => {
  it("站內路徑", () => {
    expect(isSitePath("/member")).toBe(true);
    expect(isSitePath("/shop/orders?tab=1#top")).toBe(true);
    expect(isSitePath("/")).toBe(true);
  });

  it.each([["站外網址", "https://elsewhere.test/"], ["// 開頭", "//elsewhere.test"], ["反斜線", "/\\elsewhere.test"], ["換行", "/mem\nber"], ["tab", "/mem\tber"], ["相對路徑", "member"], ["空字串", ""], ["不是字串", 42], ["null", null]])(
    "%s 不是",
    (_name, href) => {
      expect(isSitePath(href)).toBe(false);
    },
  );
});
