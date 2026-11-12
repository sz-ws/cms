import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// 2.0 草稿預覽的把關:Next 的 draft mode cookie 是整次建置共用的值,不綁人。帶著它的公開頁請求,
// middleware 每次確認這個瀏覽器現在還是一位編輯;不是就把 cookie 從請求拿掉、在回應裡刪掉,
// 頁面照一般訪客回應(快取照常命中)。登出也關掉 draft mode。

vi.mock("@/lib/cf", () => ({ getEnv: () => env, getDB: () => (env as { DB: unknown }).DB }));
const draft = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("next/headers", () => ({
  draftMode: async () => ({ disable: () => draft.calls.push("disable"), enable: () => draft.calls.push("enable") }),
  cookies: async () => ({ get: () => undefined, delete: () => {}, set: () => {} }),
}));
vi.mock("@/lib/db", () => ({ db: () => ({ delete: () => ({ where: async () => {} }) }) }));

import { NextRequest } from "next/server";
import { PREVIEW_COOKIE, isEditorSession, withoutPreviewCookie } from "../src/lib/preview-access";
import { middleware } from "../src/middleware";
import { POST as logout } from "../src/app/api/auth/logout/route";

const d1 = () => (env as { DB: D1Database }).DB;
const NOW = 1_800_000_000_000;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function user(id: string, role: string, staffRoleId: string | null = null): Promise<void> {
  await d1()
    .prepare("INSERT INTO users (id, email, password_hash, name, role, created_at, staff_role_id) VALUES (?, ?, 'x', ?, ?, 1, ?)")
    .bind(id, `${id}@site.test`, id, role, staffRoleId)
    .run();
}
async function session(token: string, userId: string, expiresAt = NOW + 86_400_000): Promise<void> {
  await d1()
    .prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, 1)")
    .bind(await sha256Hex(token), userId, expiresAt)
    .run();
}

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS staff_roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, access TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT, staff_role_id TEXT);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  for (const table of ["sessions", "users", "staff_roles"]) await d1().exec(`DELETE FROM ${table};`);
  await d1().prepare("INSERT INTO staff_roles (id, name, access, created_at, updated_at) VALUES ('r-clerk', 'Clerk', '{}', 1, 1)").run();
  await user("ed", "editor");
  await user("ad", "admin");
  await user("member", "guest");
  await user("clerk", "guest", "r-clerk");
  await user("orphan", "guest", "r-gone");
  await session("tok-ed", "ed");
  await session("tok-ad", "ad");
  await session("tok-member", "member");
  await session("tok-clerk", "clerk");
  await session("tok-orphan", "orphan");
  await session("tok-expired", "ed", NOW - 1);
  draft.calls = [];
});

describe("isEditorSession", () => {
  it("is true for a current editor, admin or custom-role session", async () => {
    for (const token of ["tok-ed", "tok-ad", "tok-clerk"]) expect(await isEditorSession(d1(), token, NOW)).toBe(true);
  });

  it("is false without a session, for members, expired or unknown sessions, and a role that no longer exists", async () => {
    for (const token of [undefined, "", "tok-member", "tok-expired", "tok-unknown", "tok-orphan"]) {
      expect(await isEditorSession(d1(), token, NOW)).toBe(false);
    }
  });

  it("is false when the lookup fails", async () => {
    const broken = { prepare: () => { throw new Error("D1 down"); } } as unknown as D1Database;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await isEditorSession(broken, "tok-ed", NOW)).toBe(false);
  });
});

describe("withoutPreviewCookie", () => {
  it("drops only the draft mode cookie", () => {
    expect(withoutPreviewCookie(`a=1; ${PREVIEW_COOKIE}=abc; session=s`)).toBe("a=1; session=s");
    expect(withoutPreviewCookie(`${PREVIEW_COOKIE}=abc`)).toBe("");
  });
});

describe("middleware on public pages", () => {
  const request = (path: string, cookie?: string) =>
    new NextRequest(`https://site.test${path}`, cookie ? { headers: { cookie } } : undefined);

  it("lets an ordinary visitor through untouched", async () => {
    const res = await middleware(request("/blog/x", "signed_in=1"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("x-middleware-override-headers")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("keeps preview on for a signed-in editor", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const res = await middleware(request("/blog/x", `${PREVIEW_COOKIE}=v; session=tok-ed`));
    vi.useRealTimers();
    expect(res.headers.get("x-middleware-override-headers")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("ends preview after sign-out, for a member, and for a copied cookie on its own", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    for (const cookie of [`${PREVIEW_COOKIE}=v`, `${PREVIEW_COOKIE}=v; session=tok-member`, `a=1; ${PREVIEW_COOKIE}=v; session=gone`]) {
      const res = await middleware(request("/blog/x", cookie));
      // 請求上的 Cookie 不再帶 draft mode cookie(OpenNext 照這個標頭決定能不能從快取回應)。
      expect(res.headers.get("x-middleware-request-cookie") ?? "").not.toContain(PREVIEW_COOKIE);
      expect(res.headers.get("x-middleware-override-headers")).toContain("cookie");
      // 瀏覽器丟掉它。
      expect(res.headers.get("set-cookie")).toMatch(new RegExp(`^${PREVIEW_COOKIE}=;.*Expires=Thu, 01 Jan 1970`));
    }
    vi.useRealTimers();
  });
});

describe("POST /api/auth/logout", () => {
  it("also turns draft mode off", async () => {
    const res = await logout(new Request("https://site.test/api/auth/logout", { method: "POST", headers: { origin: "https://site.test" } }));
    expect(res.status).toBe(200);
    expect(draft.calls).toEqual(["disable"]);
  });
});
