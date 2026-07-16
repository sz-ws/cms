import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// POST|DELETE /api/account/avatar 的 binding-backed 整合測試(miniflare D1)。
// storage 層(R2)不在 vitest.config 的 miniflare bindings 內,故 mock
// @/lib/storage 的 putFile/deleteFile(同 test/passkey.test.ts mock @/lib/cf
// 的手法),只驗證我們自己的 glue:自助上傳、大小/型別守衛、舊檔 best-effort
// 刪除、DELETE 清欄位。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// requireAuth 由測試控制(pool-workers 無 request-scoped cookies);語意與真實一致。
const authState = vi.hoisted(() => ({
  user: null as
    | null
    | { id: string; email: string; name: string; role: "admin" | "editor" | "guest" },
}));
// requireAuth 由測試控制;語意與真實一致(最低門檻:minRole 預設 "editor",
// 層級 admin > editor > guest)。avatar route 呼叫 requireAuth("guest") → guest 放行。
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

// putFile/deleteFile mock:回傳可預期的 key,並記錄呼叫供斷言。
const storageMocks = vi.hoisted(() => ({
  putFile: vi.fn(
    async (scope: string, filename: string, _body: unknown, contentType: string) => ({
      key: `${scope}/mock/${filename}`,
      size: 42,
      contentType,
    }),
  ),
  deleteFile: vi.fn(async () => {}),
}));
vi.mock("@/lib/storage", () => ({
  putFile: storageMocks.putFile,
  deleteFile: storageMocks.deleteFile,
}));

import { POST, DELETE } from "../src/app/api/account/avatar/route";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const ORIGIN = "https://cms.test";

const SELF = {
  id: "u-self",
  email: "self@test.com",
  name: "Self",
  role: "editor" as const,
};

function postReq(form: FormData, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}/api/account/avatar`, {
    method: "POST",
    headers: { Origin: origin },
    body: form,
  });
}

function deleteReq(origin = ORIGIN): Request {
  return new Request(`${ORIGIN}/api/account/avatar`, {
    method: "DELETE",
    headers: { Origin: origin },
  });
}

function pngFile(name = "avatar.png", size = 1024): File {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

beforeAll(async () => {
  // schema 對齊 migrations/0008_user_avatar.sql 之後的 users 表。
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT);",
  );
  // hitRateLimit 沿用 login_attempts 計數表(見 test/passkey.test.ts / search.test.ts)。
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM users;");
  await d1().exec("DELETE FROM login_attempts;");
  await d1()
    .prepare(
      "INSERT INTO users (id, email, password_hash, name, role, created_at, avatar_key) VALUES (?, ?, 'x', ?, ?, 1000, NULL)",
    )
    .bind(SELF.id, SELF.email, SELF.name, SELF.role)
    .run();
  authState.user = SELF;
  storageMocks.putFile.mockClear();
  storageMocks.deleteFile.mockClear();
});

async function avatarKeyOf(id: string): Promise<string | null> {
  const row = await d1()
    .prepare("SELECT avatar_key FROM users WHERE id = ?")
    .bind(id)
    .first<{ avatar_key: string | null }>();
  return row?.avatar_key ?? null;
}

describe("POST /api/account/avatar — guards", () => {
  it("403 on cross-origin", async () => {
    const form = new FormData();
    form.set("file", pngFile());
    const res = await POST(postReq(form, "https://evil.test"));
    expect(res.status).toBe(403);
    expect(storageMocks.putFile).not.toHaveBeenCalled();
  });

  it("401 when unauthenticated", async () => {
    authState.user = null;
    const form = new FormData();
    form.set("file", pngFile());
    const res = await POST(postReq(form));
    expect(res.status).toBe(401);
    expect(storageMocks.putFile).not.toHaveBeenCalled();
  });

  it("400 when no file field", async () => {
    const res = await POST(postReq(new FormData()));
    expect(res.status).toBe(400);
  });

  it("413 when file exceeds 2MB cap", async () => {
    const form = new FormData();
    form.set("file", pngFile("big.png", 2 * 1024 * 1024 + 1));
    const res = await POST(postReq(form));
    expect(res.status).toBe(413);
    expect(storageMocks.putFile).not.toHaveBeenCalled();
    expect(await avatarKeyOf(SELF.id)).toBeNull();
  });

  it("415 on disallowed content-type", async () => {
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(10)], "shell.svg", { type: "image/svg+xml" }),
    );
    const res = await POST(postReq(form));
    expect(res.status).toBe(415);
    expect(storageMocks.putFile).not.toHaveBeenCalled();
  });

  it("415 when content-type and extension disagree", async () => {
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(10)], "avatar.txt", { type: "image/png" }),
    );
    const res = await POST(postReq(form));
    expect(res.status).toBe(415);
    expect(storageMocks.putFile).not.toHaveBeenCalled();
  });
});

describe("POST /api/account/avatar — happy path", () => {
  it("stores the file under scope avatars and updates the row", async () => {
    const form = new FormData();
    form.set("file", pngFile());
    const res = await POST(postReq(form));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      avatarKey: string;
      avatarUrl: string;
    };
    expect(body.ok).toBe(true);
    expect(body.avatarKey).toMatch(/^avatars\//);
    expect(body.avatarUrl).toBe(`/api/files/${body.avatarKey}`);

    expect(storageMocks.putFile).toHaveBeenCalledTimes(1);
    expect(storageMocks.putFile.mock.calls[0][0]).toBe("avatars");

    expect(await avatarKeyOf(SELF.id)).toBe(body.avatarKey);
    // no previous avatar → nothing to delete.
    expect(storageMocks.deleteFile).not.toHaveBeenCalled();
  });

  it("best-effort deletes the previous avatar file on re-upload", async () => {
    const first = await POST(
      postReq((() => {
        const f = new FormData();
        f.set("file", pngFile());
        return f;
      })()),
    );
    const firstBody = (await first.json()) as { avatarKey: string };

    const second = await POST(
      postReq((() => {
        const f = new FormData();
        f.set("file", pngFile("avatar2.png"));
        return f;
      })()),
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { avatarKey: string };

    expect(secondBody.avatarKey).not.toBe(firstBody.avatarKey);
    expect(storageMocks.deleteFile).toHaveBeenCalledWith(firstBody.avatarKey);
    expect(await avatarKeyOf(SELF.id)).toBe(secondBody.avatarKey);
  });

  it("delete failure on old avatar is logged, not fatal", async () => {
    storageMocks.deleteFile.mockRejectedValueOnce(new Error("boom"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const form1 = new FormData();
    form1.set("file", pngFile());
    await POST(postReq(form1));

    const form2 = new FormData();
    form2.set("file", pngFile("avatar2.png"));
    const res = await POST(postReq(form2));

    expect(res.status).toBe(200);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe("DELETE /api/account/avatar", () => {
  it("403 on cross-origin, 401 unauthenticated", async () => {
    expect((await DELETE(deleteReq("https://evil.test"))).status).toBe(403);
    authState.user = null;
    expect((await DELETE(deleteReq())).status).toBe(401);
  });

  it("clears avatarKey and best-effort deletes the file", async () => {
    const form = new FormData();
    form.set("file", pngFile());
    const uploadRes = await POST(postReq(form));
    const { avatarKey } = (await uploadRes.json()) as { avatarKey: string };
    storageMocks.deleteFile.mockClear();

    const res = await DELETE(deleteReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    expect(await avatarKeyOf(SELF.id)).toBeNull();
    expect(storageMocks.deleteFile).toHaveBeenCalledWith(avatarKey);
  });

  it("is idempotent when there is no avatar set", async () => {
    const res = await DELETE(deleteReq());
    expect(res.status).toBe(200);
    expect(storageMocks.deleteFile).not.toHaveBeenCalled();
    expect(await avatarKeyOf(SELF.id)).toBeNull();
  });
});
