import { describe, it, expect, vi, afterEach } from "vitest";
import type { ComponentType } from "react";
import { HookBus } from "../src/ext/hooks";
import { normalizePublicWidgets } from "../src/ext/public-widgets";

// 1.24.0 公開站浮層插槽的兩個契約:
//   1. filter:publicWidgets 是**累加**的 —— N 個 extension 各自 append,彼此看得見,
//      且不受註冊(= 安裝)順序影響存活與否。這正是它沒有寄生在 publicFooter 的原因。
//   2. layout 不信任回傳值 —— 壞掉的一項只賠掉那一項,公開站不會 500。

const A = (() => null) as ComponentType;
const B = (() => null) as ComponentType;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("filter:publicWidgets append semantics", () => {
  it("每個 extension append 自己的浮層,兩個都活著", async () => {
    const bus = new HookBus();
    bus.register("ext-a", "filter:publicWidgets", (w: ComponentType[]) => [
      ...w,
      A,
    ]);
    bus.register("ext-b", "filter:publicWidgets", (w: ComponentType[]) => [
      ...w,
      B,
    ]);

    const out = await bus.applyFilters<ComponentType[]>(
      "filter:publicWidgets",
      [],
    );
    expect(out).toEqual([A, B]);
  });

  it("反過來註冊只換順序,不會有人消失", async () => {
    const bus = new HookBus();
    bus.register("ext-b", "filter:publicWidgets", (w: ComponentType[]) => [
      ...w,
      B,
    ]);
    bus.register("ext-a", "filter:publicWidgets", (w: ComponentType[]) => [
      ...w,
      A,
    ]);

    const out = await bus.applyFilters<ComponentType[]>(
      "filter:publicWidgets",
      [],
    );
    expect(out).toEqual([B, A]);
    expect(out).toHaveLength(2);
  });

  it("這是與 publicFooter 的差別:取代語意會吃掉先註冊者", async () => {
    // 對照組 —— 說明為什麼浮層需要自己的插槽。頁尾 extension 慣常寫成
    // `() => MyFooter`(無視傳入值),於是後註冊者贏,先註冊者靜默消失。
    const bus = new HookBus();
    bus.register("ext-widget", "filter:publicFooter", () => A);
    bus.register("ext-theme", "filter:publicFooter", () => B);

    const out = await bus.applyFilters<ComponentType | null>(
      "filter:publicFooter",
      null,
    );
    expect(out).toBe(B); // A 不見了
  });

  it("一個 handler 拋錯不影響其他 handler(值沿用上一手)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = new HookBus();
    bus.register("ext-a", "filter:publicWidgets", (w: ComponentType[]) => [
      ...w,
      A,
    ]);
    bus.register("ext-boom", "filter:publicWidgets", () => {
      throw new Error("boom");
    });
    bus.register("ext-b", "filter:publicWidgets", (w: ComponentType[]) => [
      ...w,
      B,
    ]);

    const out = await bus.applyFilters<ComponentType[]>(
      "filter:publicWidgets",
      [],
    );
    expect(out).toEqual([A, B]);
  });
});

describe("normalizePublicWidgets", () => {
  it("沒有任何 extension 註冊時是空陣列", () => {
    expect(normalizePublicWidgets([])).toEqual([]);
  });

  it("handler 忘了 return(undefined)→ 空陣列,不是 throw", () => {
    expect(normalizePublicWidgets(undefined)).toEqual([]);
  });

  it("handler 回傳單一元件而非陣列 → 空陣列,不是 throw", () => {
    expect(normalizePublicWidgets(A)).toEqual([]);
  });

  it("handler 回傳物件 → 空陣列,不是 throw", () => {
    expect(normalizePublicWidgets({ 0: A, length: 1 })).toEqual([]);
  });

  it("陣列裡的壞項目逐一丟掉,同陣列的好項目留著", () => {
    expect(normalizePublicWidgets([A, null, "nope", undefined, 42, B])).toEqual([
      A,
      B,
    ]);
  });
});
