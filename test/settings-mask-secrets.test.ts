import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";

// maskSecrets:設定頁拿到的值。存過的密鑰遮成 "•••"(畫面寫「已設定」);
// 沒存過的(空字串)照實給空,不能讓人以為那格有東西。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// 同 settings-cache.test.ts:空 rt.enabled 讓 secret 判定只剩 CORE_SETTINGS。
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

import { maskSecrets } from "../src/lib/settings";

describe("maskSecrets", () => {
  it("masks a saved secret and leaves an empty one empty", async () => {
    const out = await maskSecrets({
      "core.ai.apiKey": "sk-saved",
      "core.resendApiKey": "",
      "core.siteName": "測試商店",
    });
    expect(out).toEqual({
      "core.ai.apiKey": "•••",
      "core.resendApiKey": "",
      "core.siteName": "測試商店",
    });
  });

  it("a secret that is missing or null is not shown as saved", async () => {
    const out = await maskSecrets({ "core.ai.apiKey": null, "core.resendApiKey": undefined });
    expect(out["core.ai.apiKey"]).toBe("");
    expect(out["core.resendApiKey"]).toBe("");
  });
});
