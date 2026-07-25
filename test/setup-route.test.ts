import { describe, it, expect, beforeEach, vi } from "vitest";

// POST /api/setup 是整個產品唯一一個「未驗證卻能建立 admin」的端點。
// 它的每一道關卡都是安全邊界,而且失敗的方式都很安靜 —— 拿掉 token 檢查,
// 產品照樣跑得好好的,只是誰先找到網址誰就是管理員。所以這裡逐關守。
//
// 關卡順序本身也是被守的對象:
//   rate limit → SETUP_TOKEN 有沒有設定 → body 上限 → schema → token 比對
//   → 使用者存在性 → hashPassword → 原子 INSERT
// token 比對必須在存在性檢查之前(否則 403 變成免 token 的探測點);
// 存在性檢查必須在 hashPassword 之前(否則這個端點是免費的雜湊放大器)。

const env = vi.hoisted(() => ({ value: {} as { SETUP_TOKEN?: string } }));
const db = vi.hoisted(() => ({
  /** 現有使用者數。0 = 還沒 setup。 */
  userCount: 0,
  /** 依序記錄被呼叫的關卡,用來斷言順序與「有沒有白花力氣」。 */
  trace: [] as string[],
}));
const limiter = vi.hoisted(() => ({ blocked: false }));

vi.mock("@/lib/cf", () => ({
  getEnv: () => env.value,
  getDB: () => ({
    prepare: (sql: string) => ({
      first: async () => {
        db.trace.push("existence-check");
        return db.userCount > 0 ? { 1: 1 } : null;
      },
      bind: () => ({
        run: async () => {
          db.trace.push("insert");
          // 模擬 INSERT ... WHERE (SELECT COUNT(*) FROM users) = 0
          const changes = db.userCount === 0 ? 1 : 0;
          if (changes === 1) db.userCount += 1;
          return { meta: { changes } };
        },
      }),
      _sql: sql,
    }),
  }),
}));

vi.mock("@/lib/rate-limit", () => ({
  hitRateLimit: async () => {
    db.trace.push("rate-limit");
    return limiter.blocked;
  },
}));

vi.mock("@/lib/settings", () => ({ setSettings: async () => {} }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: () => {} }),
}));

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    // 真的跑 6×100k PBKDF2 會讓這支測試變成數秒等待。換成便宜的替身,
    // 但仍然記進 trace —— 這裡要守的是「它有沒有被呼叫」,不是它算什麼。
    hashPassword: async () => {
      db.trace.push("hash-password");
      return "pbkdf2c$6$100000$0$AA==$AA==";
    },
    createSession: async () => "session-token",
  };
});

const { POST } = await import("../src/app/api/setup/route");

const TOKEN = "test-setup-token-value";
const ORIGIN = "https://example.test";

function request(body: Record<string, unknown>): Request {
  return new Request(`${ORIGIN}/api/setup`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      host: "example.test",
    },
    body: JSON.stringify(body),
  });
}

function validBody(over: Record<string, unknown> = {}) {
  return {
    email: "admin@example.test",
    password: "correct horse battery staple",
    name: "Admin",
    siteTitle: "My Site",
    setupToken: TOKEN,
    ...over,
  };
}

beforeEach(() => {
  env.value = { SETUP_TOKEN: TOKEN };
  db.userCount = 0;
  db.trace = [];
  limiter.blocked = false;
});

describe("POST /api/setup", () => {
  it("帶對 token 的第一個請求可以建立管理員", async () => {
    const res = await POST(request(validBody()));
    expect(res.status).toBe(200);
    expect(db.trace).toContain("insert");
  });

  it("token 不對 → 401,而且完全不碰資料庫、不做雜湊", async () => {
    const res = await POST(request(validBody({ setupToken: "wrong" })));
    expect(res.status).toBe(401);
    expect(db.trace).not.toContain("existence-check");
    expect(db.trace).not.toContain("hash-password");
    expect(db.trace).not.toContain("insert");
  });

  it("缺 token 欄位 → 400(schema 就擋掉,不是當成空字串比對)", async () => {
    const body = validBody();
    delete (body as Record<string, unknown>).setupToken;
    const res = await POST(request(body));
    expect(res.status).toBe(400);
    expect(db.trace).not.toContain("hash-password");
  });

  // 這是整組的重點之一:沒設定 SETUP_TOKEN 要 fail-closed。
  // 若改成「沒設定就放行」,搶註冊窗口會原封不動地回來,而且沒有任何徵兆。
  it("部署沒設定 SETUP_TOKEN → 503,絕不放行", async () => {
    env.value = {};
    const res = await POST(request(validBody()));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: "setup_token_not_configured",
    });
    expect(db.trace).not.toContain("insert");
  });

  it("空字串的 SETUP_TOKEN 等同沒設定", async () => {
    env.value = { SETUP_TOKEN: "" };
    const res = await POST(request(validBody({ setupToken: "" })));
    expect(res.status).toBe(503);
  });

  // 這是另一個重點:setup 完成之後端點仍然公開,原本會先跑滿 6×100k PBKDF2
  // 才發現「已經有人了」。那讓任何人都能用極便宜的請求換走昂貴的伺服器運算。
  it("已經 setup 過:先做存在性檢查,不付雜湊成本就回 403", async () => {
    db.userCount = 1;
    const res = await POST(request(validBody()));
    expect(res.status).toBe(403);
    expect(db.trace).toContain("existence-check");
    expect(db.trace).not.toContain("hash-password");
    expect(db.trace.indexOf("existence-check")).toBeLessThan(
      db.trace.indexOf("hash-password") === -1
        ? Number.POSITIVE_INFINITY
        : db.trace.indexOf("hash-password"),
    );
  });

  it("限流在最前面 —— 被擋下時什麼都不做", async () => {
    limiter.blocked = true;
    const res = await POST(request(validBody()));
    expect(res.status).toBe(429);
    expect(db.trace).toEqual(["rate-limit"]);
  });

  it("跨站來源直接擋掉", async () => {
    const req = new Request(`${ORIGIN}/api/setup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.test",
        host: "example.test",
      },
      body: JSON.stringify(validBody()),
    });
    const res = await POST(req);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(db.trace).not.toContain("insert");
  });
});
