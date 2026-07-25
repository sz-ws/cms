import { describe, it, expect, beforeEach, vi } from "vitest";

// POST /api/media/alt 的守衛與驗證測試。純 mock 隔離 I/O(auth / rate-limit /
// storage),聚焦 route 自己的責任:origin 檢查、admin gating、rate limit、
// key 形狀、alt 型別/長度、以及 storage 回傳的 not_found / conflict 對應狀態碼。
// storage 層本身(R2 customMetadata 讀寫)由 test/media-alt.test.ts 覆蓋。

const authState = vi.hoisted(() => ({
  user: null as
    | null
    | { id: string; email: string; name: string; role: "admin" | "editor" },
}));
const ROLE_RANK: Record<string, number> = { guest: 1, editor: 2, admin: 3 };
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAuth: async (minRole: "admin" | "editor" | "guest" = "editor") => {
      if (!authState.user) throw new actual.AuthError(401);
      if (ROLE_RANK[authState.user.role] < ROLE_RANK[minRole]) {
        throw new actual.AuthError(403);
      }
      return authState.user;
    },
  };
});

const rateLimitState = vi.hoisted(() => ({ blocked: false }));
vi.mock("@/lib/rate-limit", () => ({
  hitRateLimit: async () => rateLimitState.blocked,
}));

const storageState = vi.hoisted(() => ({
  calls: [] as { key: string; alt: string }[],
  result: null as unknown,
}));
vi.mock("@/lib/storage", () => ({
  MAX_ALT_LENGTH: 500,
  updateFileAlt: async (key: string, alt: string) => {
    storageState.calls.push({ key, alt });
    return storageState.result;
  },
}));

import { POST } from "../src/app/api/media/alt/route";

const ORIGIN = "https://cms.test";
const KEY = "core/2026/07/abc123.png";
const ADMIN = { id: "u-admin", email: "a@test.com", name: "A", role: "admin" as const };
const EDITOR = { id: "u-ed", email: "e@test.com", name: "E", role: "editor" as const };

function req(body: unknown, origin: string | null = ORIGIN): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  return new Request(`${ORIGIN}/api/media/alt`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  authState.user = ADMIN;
  rateLimitState.blocked = false;
  storageState.calls = [];
  storageState.result = {
    ok: true,
    file: { key: KEY, size: 7, contentType: "image/png", alt: "a red bike" },
  };
});

describe("POST /api/media/alt", () => {
  it("rejects a missing/foreign Origin before touching storage", async () => {
    expect((await POST(req({ key: KEY, alt: "x" }, null))).status).toBe(403);
    expect(
      (await POST(req({ key: KEY, alt: "x" }, "https://evil.test"))).status,
    ).toBe(403);
    expect(storageState.calls).toHaveLength(0);
  });

  it("requires an admin session", async () => {
    authState.user = null;
    expect((await POST(req({ key: KEY, alt: "x" }))).status).toBe(401);
    authState.user = EDITOR;
    expect((await POST(req({ key: KEY, alt: "x" }))).status).toBe(403);
    expect(storageState.calls).toHaveLength(0);
  });

  it("429s when rate limited", async () => {
    rateLimitState.blocked = true;
    expect((await POST(req({ key: KEY, alt: "x" }))).status).toBe(429);
    expect(storageState.calls).toHaveLength(0);
  });

  it("400s on invalid json / missing key / non-managed key", async () => {
    expect((await POST(req("{not json"))).status).toBe(400);
    expect((await POST(req({ alt: "x" }))).status).toBe(400);
    for (const bad of [
      "core/2026/07/../../secret.png",
      "/core/2026/07/abc.png",
      "core/abc.png",
      "core/2026/07/abc.exefileextensiontoolong",
    ]) {
      const res = await POST(req({ key: bad, alt: "x" }));
      expect(res.status, bad).toBe(400);
    }
    expect(storageState.calls).toHaveLength(0);
  });

  it("400s when alt is not a string or is too long", async () => {
    expect((await POST(req({ key: KEY }))).status).toBe(400);
    expect((await POST(req({ key: KEY, alt: 42 }))).status).toBe(400);
    const long = await POST(req({ key: KEY, alt: "x".repeat(501) }));
    expect(long.status).toBe(400);
    expect(await long.json()).toEqual({ error: "alt_too_long" });
    expect(storageState.calls).toHaveLength(0);
  });

  it("accepts an empty alt (clears it) and passes it through verbatim", async () => {
    storageState.result = {
      ok: true,
      file: { key: KEY, size: 7, contentType: "image/png" },
    };
    const res = await POST(req({ key: KEY, alt: "" }));
    expect(res.status).toBe(200);
    expect(storageState.calls).toEqual([{ key: KEY, alt: "" }]);
    expect(await res.json()).toEqual({
      ok: true,
      file: { key: KEY, size: 7, contentType: "image/png" },
    });
  });

  it("returns the updated file on success", async () => {
    const res = await POST(req({ key: KEY, alt: "a red bike" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      file: { key: KEY, size: 7, contentType: "image/png", alt: "a red bike" },
    });
  });

  it("maps storage not_found → 404 and conflict → 409", async () => {
    storageState.result = { ok: false, reason: "not_found" };
    expect((await POST(req({ key: KEY, alt: "x" }))).status).toBe(404);
    storageState.result = { ok: false, reason: "conflict" };
    const res = await POST(req({ key: KEY, alt: "x" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict" });
  });
});
