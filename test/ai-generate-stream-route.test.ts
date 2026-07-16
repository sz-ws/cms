import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import type { AiStreamEvent } from "../src/ext/providers/ai";

// POST /api/ai/generate/stream 的 binding-backed 整合測試,mirrors
// test/ai-generate-route.test.ts 的既有慣例(同一份 guard/mock 手法)——差別只在
// 回應改為 NDJSON over ReadableStream,passthrough 測試改為逐行讀 body 而非
// 單一 res.json()。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

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

// route.ts 在 handler 內 dynamic import "@/lib/ai"(同 ../route.ts 慣例)。vi.mock
// 對 dynamic import 一樣生效——直接控制 generateAiTextStream 產出的事件序列,
// 不需要真的接上 provider registry。
const aiStreamState = vi.hoisted(() => ({
  events: [
    { type: "delta", text: "hi" },
    { type: "done", model: "test-model" },
  ] as AiStreamEvent[],
  calls: [] as unknown[],
}));
vi.mock("@/lib/ai", () => ({
  generateAiTextStream: vi.fn(async function* (opts: unknown) {
    aiStreamState.calls.push(opts);
    for (const event of aiStreamState.events) yield event;
  }),
}));

import { POST } from "../src/app/api/ai/generate/stream/route";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const ORIGIN = "https://cms.test";
const ADMIN = {
  id: "u-admin-stream",
  email: "admin-stream@test.com",
  name: "Admin",
  role: "admin" as const,
};
const EDITOR = {
  id: "u-editor-stream",
  email: "editor-stream@test.com",
  name: "Editor",
  role: "editor" as const,
};

function postReq(body: unknown, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}/api/ai/generate/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = { messages: [{ role: "user", content: "hi" }] };

// res.text() 對非 text/* 的 Content-Type(這裡是 application/x-ndjson)會在
// Miniflare 底下印一個無害但吵的警告("does not appear to be text")。改用
// arrayBuffer() + TextDecoder 手動解碼,語意相同、不觸發該警告。
async function readNdjson(res: Response): Promise<AiStreamEvent[]> {
  const buf = await res.arrayBuffer();
  const text = new TextDecoder().decode(buf);
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AiStreamEvent);
}

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM login_attempts;");
  authState.user = ADMIN;
  aiStreamState.events = [
    { type: "delta", text: "hi" },
    { type: "done", model: "test-model" },
  ];
  aiStreamState.calls = [];
});

describe("POST /api/ai/generate/stream — guards", () => {
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
    ]) {
      const res = await POST(postReq(body));
      expect(res.status).toBe(400);
    }
  });
});

describe("POST /api/ai/generate/stream — NDJSON passthrough", () => {
  it("200s with Content-Type application/x-ndjson and streams events as one-JSON-per-line", async () => {
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
    const events = await readNdjson(res);
    expect(events).toEqual([
      { type: "delta", text: "hi" },
      { type: "done", model: "test-model" },
    ]);
    expect(aiStreamState.calls).toHaveLength(1);
  });

  it("still 200s and streams a single error event when the provider isn't configured", async () => {
    aiStreamState.events = [{ type: "error", error: "not_configured" }];
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(200);
    const events = await readNdjson(res);
    expect(events).toEqual([{ type: "error", error: "not_configured" }]);
  });

  it("429 after exceeding the shared 10/min 'ai-generate' rate limit bucket", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await POST(postReq(VALID_BODY));
      expect(res.status).toBe(200);
      await res.arrayBuffer(); // 只是把 body 排空,同上避免 res.text() 的 Miniflare 警告。
    }
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(429);
  });
});
