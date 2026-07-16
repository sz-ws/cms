import { describe, it, expect, vi } from "vitest";

// core-v2 §2.2 provides 接線的單元測試:registerExtensionProviders 把 enabled code
// extension 的 provides 註冊進同一個 registry。純函式路徑 —— 不碰 loader/DB(避開
// workers pool 的 next/navigation 地雷),直接以 fake extension + fake makeServices
// 驗證接線契約。
//
// settings 被 providers.ts 的 core 內建 provider(ResendEmailProvider 等)於 import
// 期不呼叫,僅 mock 掉以防任何 top-level 觸達;registry 建立本身不讀 settings。
vi.mock("@/lib/settings", () => ({
  getSetting: async (_k: string, fallback?: unknown) => fallback,
  setSettings: async () => {},
}));

import { createRegistry, registerExtensionProviders } from "../src/ext/providers";
import { HookBus } from "../src/ext/hooks";
import type { Extension } from "../src/ext/types";
import type { CoreServices } from "../src/ext/services";

const FAKE_SERVICES = {} as CoreServices;

/** 造一個帶 provides 的 code extension（僅填接線相關欄位）。 */
function extWithProvides(
  id: string,
  provides: Extension["provides"],
): Extension {
  return {
    id,
    name: id,
    version: "1.0.0",
    coreApi: "^1.0.0",
    provides,
  };
}

describe("registerExtensionProviders (provides 接線)", () => {
  it("把 enabled extension 的 provides 註冊進同一 registry，並以其自身 extId 建 services", () => {
    const reg = createRegistry(new HookBus());
    const impl = { tag: "acme-widget" };
    const makeServices = vi.fn(() => FAKE_SERVICES);

    const ext = extWithProvides("acme", [
      { capability: "widget", id: "acme", create: () => impl },
    ]);

    // 接線前：capability 不存在。
    expect(reg.capabilities()).not.toContain("widget");

    registerExtensionProviders(reg, [ext], makeServices);

    // 接線後：capability 出現，getById 精確命中該 impl。
    expect(reg.capabilities()).toContain("widget");
    expect(reg.getById("widget", "acme")).toBe(impl);
    // create() 收到綁定「該 provider 自身 extension id」的 scoped services。
    expect(makeServices).toHaveBeenCalledWith("acme");
  });

  it("disabled（不在 enabled 陣列）的 extension，其 provides 不註冊", () => {
    const reg = createRegistry(new HookBus());
    // enabled 為空（模擬該 extension 被停用，loader 不會把它放進 rt.enabled）。
    registerExtensionProviders(reg, [], () => FAKE_SERVICES);
    expect(reg.capabilities()).not.toContain("widget");
    expect(reg.getById("widget", "acme")).toBeNull();
  });

  it("沒有 provides 的 extension 是 no-op", () => {
    const reg = createRegistry(new HookBus());
    const before = reg.capabilities().sort();
    const ext = extWithProvides("plain", undefined);
    registerExtensionProviders(reg, [ext], () => FAKE_SERVICES);
    expect(reg.capabilities().sort()).toEqual(before);
  });

  it("重複 (capability,id) fail-loud：register() throw，不吞", () => {
    const reg = createRegistry(new HookBus());
    const dup = extWithProvides("dup", [
      { capability: "widget", id: "acme", create: () => ({}) },
      { capability: "widget", id: "acme", create: () => ({}) },
    ]);
    expect(() =>
      registerExtensionProviders(reg, [dup], () => FAKE_SERVICES),
    ).toThrow(/duplicate provider id/);
  });

  it("多個 enabled extension 各自的 provides 皆註冊", () => {
    const reg = createRegistry(new HookBus());
    const a = extWithProvides("a", [
      { capability: "cap-a", id: "a", create: () => ({ n: 1 }) },
    ]);
    const b = extWithProvides("b", [
      { capability: "cap-b", id: "b", create: () => ({ n: 2 }) },
    ]);
    registerExtensionProviders(reg, [a, b], () => FAKE_SERVICES);
    expect(reg.capabilities()).toEqual(expect.arrayContaining(["cap-a", "cap-b"]));
  });
});
