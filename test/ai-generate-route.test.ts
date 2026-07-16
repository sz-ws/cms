import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// POST /api/ai/generate 的 binding-backed 整合測試(miniflare D1,同
// test/users-api.test.ts / test/search.test.ts 慣例)。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// requireAuth 由測試控制(pool-workers 無 request-scoped cookies);
// role gating 語意與真實版一致:未登入 401、role 不符 403。
const authState = vi.hoisted(() => ({
  user: null as
    | null
    | { id: string; email: string; name: string; role: "admin" | "editor" },
}));
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAuth: async (role?: "admin") => {
      if (!authState.user) throw new actual.AuthError(401);
      if (role && authState.user.role !== role)
        throw new actual.AuthError(403);
      return authState.user;
    },
  };
});

// route.ts 在 handler 內 dynamic import "@/lib/ai"(避開 loader/services 鏈,見該檔
// 檔頭註解)。vi.mock 對 dynamic import 一樣生效,route 測試因此不需要真的接上
// provider registry —— 直接控制 generateAiText 的回傳值。
interface CapturedResult {
  ok: boolean;
  text?: string;
  error?: string;
  model?: string;
}
const aiState = vi.hoisted(() => ({
  result: { ok: true, text: "hi", model: "test-model" } as CapturedResult,
  calls: [] as unknown[],
}));
vi.mock("@/lib/ai", () => ({
  generateAiText: vi.fn(async (opts: unknown) => {
    aiState.calls.push(opts);
    return aiState.result;
  }),
}));

import { POST } from "../src/app/api/ai/generate/route";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const ORIGIN = "https://cms.test";
const ADMIN = {
  id: "u-admin",
  email: "admin@test.com",
  name: "Admin",
  role: "admin" as const,
};
const EDITOR = {
  id: "u-editor",
  email: "editor@test.com",
  name: "Editor",
  role: "editor" as const,
};

function postReq(body: unknown, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}/api/ai/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = { messages: [{ role: "user", content: "hi" }] };

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM login_attempts;");
  authState.user = ADMIN;
  aiState.result = { ok: true, text: "hi", model: "test-model" };
  aiState.calls = [];
});

describe("POST /api/ai/generate — guards", () => {
  it("403 on cross-origin", async () => {
    const res = await POST(postReq(VALID_BODY, "https://evil.test"));
    expect(res.status).toBe(403);
  });

  it("401 unauthenticated", async () => {
    authState.user = null;
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it("403 non-admin", async () => {
    authState.user = EDITOR;
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(403);
  });

  it("400 on malformed bodies (zod .strict())", async () => {
    for (const body of [
      {},
      { messages: [] },
      { messages: [{ role: "bogus", content: "hi" }] },
      { messages: [{ role: "user", content: "hi" }], nope: 1 },
      { messages: [{ role: "user", content: "hi" }], maxTokens: -1 },
      { messages: [{ role: "user", content: "hi" }], maxTokens: "big" },
    ]) {
      const res = await POST(postReq(body));
      expect(res.status).toBe(400);
    }
  });
});

describe("POST /api/ai/generate — passthrough", () => {
  it("200s and returns the AiGenerateResult as-is on success", async () => {
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      text: "hi",
      model: "test-model",
    });
    expect(aiState.calls).toHaveLength(1);
  });

  it("still 200s when the provider result is ok:false (passthrough, not error mapping)", async () => {
    aiState.result = { ok: false, error: "not_configured" };
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, error: "not_configured" });
  });

  it("429 after exceeding the 10/min rate limit", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await POST(postReq(VALID_BODY));
      expect(res.status).toBe(200);
    }
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(429);
  });
});
