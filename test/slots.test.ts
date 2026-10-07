import { describe, it, expect, vi } from "vitest";
import { SlotRegistry, defineSlot, defineValueSlot, fill, type SlotSource } from "../src/ext/slots";

// 插槽(src/ext/slots.ts):可以被改的地方有一個名字,上層往裡面填。
// 值的插槽:填的是「把值改成什麼」;畫面的插槽:填的是放在前面、後面、換掉、包起來的元件。
// 先後照層:一般插件 → 代理商那一層(agency)→ 這個站自己(site);同一層照登記的順序。

const Names = defineValueSlot<string[]>("test.names");
const Greeting = defineValueSlot<string>("test.greeting");
const Panel = defineSlot<{ title: string }>("test.panel");

const A = () => null;
const B = () => null;
const C = () => null;

const add = (name: string) => fill(Names, (names) => [...names, name]);

describe("宣告插槽", () => {
  it("名字是用點分開的小寫段落,至少兩段", () => {
    expect(defineValueSlot<number>("admin.sidebar.items").id).toBe("admin.sidebar.items");
    expect(defineSlot("agency-admin.order-notes").id).toBe("agency-admin.order-notes");
    for (const bad of ["", "sidebar", "Admin.sidebar", "admin..items", "admin.sidebar ", "admin/sidebar"]) {
      expect(() => defineValueSlot<number>(bad), bad).toThrow(/slot id/);
      expect(() => defineSlot(bad), bad).toThrow(/slot id/);
    }
  });
});

describe("值的插槽", () => {
  it("沒有人填就是原本的值", () => {
    const base = ["core"];
    expect(new SlotRegistry([]).value(Names, base)).toBe(base);
    expect(new SlotRegistry([{ extId: "shop" }]).value(Names, base)).toBe(base);
  });

  it("照層的先後填:一般插件、代理商、站台;跟登記的順序無關", () => {
    const sources: SlotSource[] = [
      { extId: "site", layer: "site", fills: [add("site")] },
      { extId: "agency", layer: "agency", fills: [add("agency")] },
      { extId: "plugin", fills: [add("plugin")] },
    ];
    expect(new SlotRegistry(sources).value(Names, ["core"])).toEqual(["core", "plugin", "agency", "site"]);
  });

  it("同一層照登記的順序,同一個插件裡照寫的順序", () => {
    const sources: SlotSource[] = [
      { extId: "one", fills: [add("one-a"), add("one-b")] },
      { extId: "two", fills: [add("two")] },
    ];
    expect(new SlotRegistry(sources).value(Names, [])).toEqual(["one-a", "one-b", "two"]);
  });

  it("只填到自己那個插槽", () => {
    const sources: SlotSource[] = [{ extId: "one", fills: [add("one"), fill(Greeting, (text) => `${text}!`)] }];
    const slots = new SlotRegistry(sources);
    expect(slots.value(Names, [])).toEqual(["one"]);
    expect(slots.value(Greeting, "hi")).toBe("hi!");
  });

  it("填的時候可以讀別的插槽", () => {
    const sources: SlotSource[] = [
      { extId: "agency", layer: "agency", fills: [fill(Greeting, (text, { slots }) => `${text} ${slots.value(Names, ["world"]).join(" & ")}`)] },
      { extId: "site", layer: "site", fills: [add("site")] },
    ];
    expect(new SlotRegistry(sources).value(Greeting, "hello")).toBe("hello world & site");
  });

  it("一個填的出錯:跳過它、回報,其他照常", () => {
    const onError = vi.fn();
    const boom = new Error("boom");
    const sources: SlotSource[] = [
      { extId: "one", fills: [add("one")] },
      { extId: "bad", fills: [fill(Names, () => { throw boom; })] },
      { extId: "two", fills: [add("two")] },
    ];
    expect(new SlotRegistry(sources, onError).value(Names, [])).toEqual(["one", "two"]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom, { slot: "test.names", ext: "bad" });
  });
});

describe("值的插槽:寫錯的填法", () => {
  it("填的時候讀自己那個插槽:當作出錯跳過,其他照常,之後還能再用", () => {
    const onError = vi.fn();
    const sources: SlotSource[] = [
      { extId: "one", fills: [add("one")] },
      { extId: "loop", fills: [fill(Names, (names, { slots }) => slots.value(Names, names))] },
      { extId: "two", fills: [add("two")] },
    ];
    const slots = new SlotRegistry(sources, onError);
    expect(slots.value(Names, [])).toEqual(["one", "two"]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toEqual({ slot: "test.names", ext: "loop" });
    expect(slots.value(Names, ["again"])).toEqual(["again", "one", "two"]);
  });

  it("回傳 Promise 的函式:值的插槽是同步的,跳過並回報", () => {
    const onError = vi.fn();
    const later = fill(Names, (async (names: string[]) => [...names, "late"]) as unknown as (names: string[]) => string[]);
    const slots = new SlotRegistry([{ extId: "async", fills: [later] }, { extId: "two", fills: [add("two")] }], onError);
    expect(slots.value(Names, [])).toEqual(["two"]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toMatch(/synchronous/);
  });

  it("fill() 當場擋掉寫錯的:值的插槽要給函式,畫面的插槽四選一", () => {
    expect(() => fill(Names, "nope" as unknown as (names: string[]) => string[])).toThrow(/needs a function/);
    const anyPlacement = (value: unknown) => value as { before: typeof A };
    expect(() => fill(Panel, anyPlacement({}))).toThrow(/exactly one/);
    expect(() => fill(Panel, anyPlacement({ before: null }))).toThrow(/exactly one/);
    expect(() => fill(Panel, anyPlacement({ before: A, after: B }))).toThrow(/exactly one/);
  });
});

describe("畫面的插槽", () => {
  it("沒有人填:前後都是空的,不換、不包", () => {
    expect(new SlotRegistry([]).view(Panel)).toEqual({ before: [], after: [], replace: null, wrap: [] });
  });

  it("前面與後面照層的先後排", () => {
    const sources: SlotSource[] = [
      { extId: "site", layer: "site", fills: [fill(Panel, { before: C }), fill(Panel, { after: C })] },
      { extId: "plugin", fills: [fill(Panel, { before: A }), fill(Panel, { after: A })] },
      { extId: "agency", layer: "agency", fills: [fill(Panel, { before: B })] },
    ];
    const plan = new SlotRegistry(sources).view(Panel);
    expect(plan.before).toEqual([A, B, C]);
    expect(plan.after).toEqual([A, C]);
  });

  it("換掉:層比較上面的贏,同一層後登記的贏", () => {
    const sources: SlotSource[] = [
      { extId: "site", layer: "site", fills: [fill(Panel, { replace: C })] },
      { extId: "one", fills: [fill(Panel, { replace: A })] },
      { extId: "two", fills: [fill(Panel, { replace: B })] },
    ];
    expect(new SlotRegistry(sources).view(Panel).replace).toBe(C);
    expect(new SlotRegistry(sources.slice(1)).view(Panel).replace).toBe(B);
  });

  it("包起來:下層在裡面,上層在外面", () => {
    const sources: SlotSource[] = [
      { extId: "site", layer: "site", fills: [fill(Panel, { wrap: C })] },
      { extId: "plugin", fills: [fill(Panel, { wrap: A })] },
    ];
    expect(new SlotRegistry(sources).view(Panel).wrap).toEqual([A, C]);
  });
});
