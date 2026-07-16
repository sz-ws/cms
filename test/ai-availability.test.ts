import { describe, it, expect, vi } from "vitest";

// spec-ai-capability.md 測試 7:ai:generate 恆註冊 → availableServices() 恆列出。
// 「註冊≠已設定」的既有語意(同 email:send)——這裡只驗證 capability 出現在集合中,
// 不涉及 core.ai.mode 是否已設定。
//
// availableServices() 內部 dynamic import "./loader" + "./services"(service-
// requirements.ts 檔頭註解已註明原因)。mock @/ext/loader 讓 rt.enabled 為空陣列,
// 同 test/notify.test.ts 的既有慣例,避開 loader.ts → interpret.tsx → next/navigation
// 這條 workers pool 地雷;services.ts 其餘相依(db/settings/storage)在此路徑下
// 只被靜態 import、不被呼叫(createRegistry 建構期零 I/O)。
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const rt = {
    enabled: [] as unknown[],
    all: [] as unknown[],
    hooks: new HookBus(),
    byId: () => undefined,
    isCompatible: () => true,
  };
  return { getExtRuntime: async () => rt };
});

import { availableServices } from "../src/ext/service-requirements";

describe("availableServices — ai:generate", () => {
  it("includes ai:generate as a registered (not necessarily configured) capability", async () => {
    const services = await availableServices();
    expect(services).toContain("ai:generate");
    // 順帶驗證既有 capability 未被本次改動移除(email:send 前例的既有回歸防線)。
    expect(services).toContain("email:send");
    expect(services).toContain("upload");
  });
});
