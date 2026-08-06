import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// ApiRoute.public(1.28.0)的 dispatcher 測試:public route 匿名可呼叫、
// same-origin 檢查照舊(宣告 public 不豁免)、未宣告的 route 維持 requireAuth。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

vi.mock("@/lib/settings", () => ({
  getSetting: async (_key: string, fallback?: unknown) => fallback,
  setSettings: async () => {},
}));

// 未登入環境:requireAuth 一律 401(pool-workers 無 request-scoped cookies)。
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAuth: async () => {
      throw new actual.AuthError(401);
    },
  };
});

const calls = vi.hoisted(() => ({ handled: [] as string[] }));
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const { defineExtension } = await import("../src/ext/types");
  const handler =
    (label: string) =>
    async (
      _req: Request,
      _params: Record<string, string>,
      ctx: { user: { id: string } },
    ) => {
      calls.handled.push(`${label}:${ctx.user.id}`);
      return Response.json({ ok: true, label });
    };
  const ext = defineExtension({
    id: "pubtest",
    name: "pubtest",
    version: "0.0.1",
    coreApi: "^1.28.0",
    apiRoutes: [
      { method: "POST", path: "open", public: true, handler: handler("open") },
      { method: "POST", path: "locked", handler: handler("locked") },
    ],
  });
  const rt = {
    enabled: [ext],
    all: [ext],
    hooks: new HookBus(),
    byId: (id: string) => (id === "pubtest" ? ext : undefined),
    isCompatible: () => true,
    unavailableById: new Map(),
  };
  return { getExtRuntime: async () => rt };
});

import { POST } from "../src/app/api/ext/[extId]/[[...path]]/route";

const ORIGIN = "https://cms.test";

function post(path: string, origin: string | null = ORIGIN): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (origin) headers.origin = origin;
  return POST(
    new Request(`${ORIGIN}/api/ext/pubtest/${path}`, {
      method: "POST",
      headers,
      body: "{}",
    }),
    { params: Promise.resolve({ extId: "pubtest", path: [path] }) },
  );
}

beforeEach(() => {
  calls.handled = [];
});

describe("ApiRoute.public", () => {
  it("public route:匿名 POST 放行,ctx.user 為 anonymous placeholder", async () => {
    const res = await post("open");
    expect(res.status).toBe(200);
    expect(calls.handled).toEqual(["open:anonymous"]);
  });

  it("public route 不豁免 same-origin:跨源 / 無 Origin 一律擋", async () => {
    const cross = await post("open", "https://evil.example");
    expect(cross.status).toBe(403);
    const none = await post("open", null);
    expect(none.status).toBe(403);
    expect(calls.handled).toEqual([]);
  });

  it("未宣告 public 的 route 維持 requireAuth(未登入 401)", async () => {
    const res = await post("locked");
    expect(res.status).toBe(401);
    expect(calls.handled).toEqual([]);
  });
});
