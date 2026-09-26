import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

// 1.56.0:core 的忘記密碼(src/lib/password-reset*.ts、/api/auth/password-reset[/confirm])與
// auth:signed-in hook(src/lib/signed-in.ts)。真 D1(miniflare)+ core 的密碼雜湊與 session;
// 只換掉寄信(從寄出的信讀驗證碼)、設定、cookie 與插件 runtime(記下 hook 收到什麼)。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => undefined,
}));

// 沒有 Cloudflare context:寄信在回應之前做完,測試才讀得到信。
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("no cloudflare context in tests");
  },
}));

const settingsState = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock("@/lib/settings", () => ({
  getSetting: async (key: string, fallback?: unknown) => (key in settingsState.values ? settingsState.values[key] : fallback),
  getPlainSetting: async (key: string, fallback?: unknown) => (key in settingsState.values ? settingsState.values[key] : fallback),
}));

type Mail = { to: string; subject: string; text?: string; html?: string };
const mail = vi.hoisted(() => ({
  ready: true,
  sent: [] as Mail[],
  result: { ok: true, id: "m1" } as { ok: true; id: string } | { ok: false; error: string },
}));
vi.mock("@/lib/email", () => ({
  emailReady: async () => mail.ready,
  sendEmail: async (msg: Mail) => {
    mail.sent.push(msg);
    return mail.result;
  },
}));

const cookieStore = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (cookieStore.map.has(k) ? { name: k, value: cookieStore.map.get(k)! } : undefined),
    set: (k: string, v: string) => void cookieStore.map.set(k, v),
    delete: (k: string) => void cookieStore.map.delete(k),
  }),
}));

const hookState = vi.hoisted(() => ({ events: [] as unknown[], explode: false }));
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const hooks = new HookBus();
  hooks.register("broken", "auth:signed-in", () => {
    if (hookState.explode) throw new Error("listener crashed");
  });
  hooks.register("test", "auth:signed-in", (event: unknown) => void hookState.events.push(event));
  const rt = { enabled: [], all: [], hooks, byId: () => undefined, isCompatible: () => true, unavailableById: new Map() };
  return { getExtRuntime: async () => rt };
});
vi.mock("@/lib/observe/report", () => ({ reportError: async () => {} }));

import { getSessionUser, hashPassword, verifyPassword } from "../src/lib/auth";
import { hitRateLimit } from "../src/lib/rate-limit";
import { CODE_TTL_MS, MAX_ATTEMPTS, RESEND_AFTER_MS, checkCode, issueCode } from "../src/lib/password-reset-codes";
import { RESET_LIMITS, STAFF_RESET_SETTING } from "../src/lib/password-reset";
import { POST as requestRoute } from "../src/app/api/auth/password-reset/route";
import { POST as confirmRoute } from "../src/app/api/auth/password-reset/confirm/route";
import { POST as loginRoute } from "../src/app/api/auth/login/route";

const db = () => (env as { DB: D1Database }).DB;
const ORIGIN = "https://cms.test";
let ip = "198.51.100.1";

function post(route: (req: Request) => Promise<Response>, path: string, body: unknown, origin = ORIGIN) {
  return route(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin, "cf-connecting-ip": ip },
      body: JSON.stringify(body),
    }),
  ).then(async (res) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> }));
}
const requestReset = (email: string, origin?: string) => post(requestRoute, "/api/auth/password-reset", { email }, origin);
const confirmReset = (body: Record<string, unknown>) => post(confirmRoute, "/api/auth/password-reset/confirm", body);

function lastCode(): string {
  const match = /\b(\d{6})\b/.exec(mail.sent.at(-1)?.text ?? "");
  if (!match) throw new Error("no code in the last email");
  return match[1];
}
const wrongCode = () => (lastCode() === "000000" ? "111111" : "000000");

async function addUser(email: string, role: string, options: { staffRoleId?: string; passwordHash?: string } = {}) {
  const id = crypto.randomUUID();
  await db()
    .prepare("INSERT INTO users (id, email, password_hash, name, role, created_at, staff_role_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, email, options.passwordHash ?? "old-hash", email, role, Date.now(), options.staffRoleId ?? null)
    .run();
  return id;
}
const user = (email: string) =>
  db().prepare("SELECT id, password_hash, email_verified_at FROM users WHERE email = ?").bind(email).first<{
    id: string; password_hash: string; email_verified_at: number | null;
  }>();
const sessionsOf = async (userId: string) =>
  (await db().prepare("SELECT id FROM sessions WHERE user_id = ?").bind(userId).all()).results.length;
const pastCooldown = (email: string) =>
  db().prepare("UPDATE password_reset_codes SET sent_at = sent_at - ? WHERE email = ?").bind(RESEND_AFTER_MS + 1, email).run();

beforeAll(async () => {
  await db().exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT, staff_role_id TEXT, email_verified_at INTEGER);",
  );
  await db().exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);");
  await db().exec("CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);");
  await db().exec("CREATE TABLE IF NOT EXISTS staff_roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, access TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);");
  await db().exec(
    "CREATE TABLE IF NOT EXISTS password_reset_codes (email TEXT PRIMARY KEY NOT NULL, nonce TEXT NOT NULL, code_hash TEXT, attempts INTEGER DEFAULT 0 NOT NULL, sent_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  for (const table of ["users", "sessions", "login_attempts", "password_reset_codes"]) await db().prepare(`DELETE FROM ${table}`).run();
  settingsState.values = { "core.locale": "en", "core.siteTitle": "Test Site" };
  mail.ready = true;
  mail.sent = [];
  mail.result = { ok: true, id: "m1" };
  cookieStore.map.clear();
  hookState.events = [];
  hookState.explode = false;
  ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("驗證碼", () => {
  it("只存以站台金鑰算的雜湊;10 分鐘過期;60 秒內不能重寄", async () => {
    const now = Date.now();
    const issued = await issueCode(db(), "life@example.com", now);
    if (!issued.ok) throw new Error("not issued");
    const row = await db().prepare("SELECT code_hash FROM password_reset_codes WHERE email = ?").bind("life@example.com").first<{ code_hash: string }>();
    expect(row!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.code_hash).not.toContain(issued.code);
    expect(await issueCode(db(), "life@example.com", now + 1_000)).toMatchObject({ ok: false });
    expect(await checkCode(db(), "life@example.com", issued.code, now + CODE_TTL_MS + 1)).toEqual({ ok: false, reason: "expired" });
  });

  it("同一組碼最多試 5 次,錯滿就作廢;打對一次就不能再用", async () => {
    const now = Date.now();
    const issued = await issueCode(db(), "tries@example.com", now);
    if (!issued.ok) throw new Error("not issued");
    const wrong = issued.code === "000000" ? "111111" : "000000";
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect(await checkCode(db(), "tries@example.com", wrong, now)).toEqual({ ok: false, reason: "wrong", attemptsLeft: MAX_ATTEMPTS - i });
    }
    expect(await checkCode(db(), "tries@example.com", wrong, now)).toEqual({ ok: false, reason: "expired" });
    expect(await checkCode(db(), "tries@example.com", issued.code, now)).toEqual({ ok: false, reason: "expired" });

    const again = await issueCode(db(), "once@example.com", now);
    if (!again.ok) throw new Error("not issued");
    expect(await checkCode(db(), "once@example.com", again.code, now)).toEqual({ ok: true });
    expect(await checkCode(db(), "once@example.com", again.code, now)).toEqual({ ok: false, reason: "expired" });
  });
});

describe("申請", () => {
  it("有帳號和沒帳號的 Email 回應一模一樣;沒帳號的不寄信", async () => {
    await addUser("known@example.com", "guest");
    const known = await requestReset("known@example.com");
    const unknown = await requestReset("unknown@example.com");
    expect(known).toEqual({ status: 200, body: { ok: true, resendIn: 60 } });
    expect(unknown).toEqual(known);
    expect(mail.sent.map((m) => m.to)).toEqual(["known@example.com"]);
    // 冷卻也一樣:60 秒內再按,兩邊都回 cooldown。
    expect((await requestReset("known@example.com")).body).toMatchObject({ error: "cooldown" });
    expect((await requestReset("unknown@example.com")).body).toMatchObject({ error: "cooldown" });
  });

  it("會員與後台人員(預設)都收到驗證碼", async () => {
    await addUser("member@example.com", "guest");
    await addUser("admin@example.com", "admin");
    await addUser("clerk@example.com", "guest", { staffRoleId: "role-1" });
    for (const email of ["member@example.com", "admin@example.com", "clerk@example.com"]) {
      await requestReset(email);
      expect(mail.sent.at(-1)!.to).toBe(email);
      expect(lastCode()).toMatch(/^\d{6}$/);
    }
  });

  it("關掉後台人員重設:後台人員只收到「請聯絡管理員」,沒有驗證碼;會員照舊", async () => {
    settingsState.values[STAFF_RESET_SETTING] = false;
    await addUser("admin@example.com", "admin");
    await addUser("clerk@example.com", "guest", { staffRoleId: "role-1" });
    await addUser("member@example.com", "guest");
    for (const email of ["admin@example.com", "clerk@example.com"]) {
      expect(await requestReset(email)).toEqual({ status: 200, body: { ok: true, resendIn: 60 } });
      expect(mail.sent.at(-1)!.to).toBe(email);
      expect(mail.sent.at(-1)!.text).not.toMatch(/\b\d{6}\b/);
    }
    await requestReset("member@example.com");
    expect(lastCode()).toMatch(/^\d{6}$/);
  });

  it("寄不出信:503,不寫碼", async () => {
    mail.ready = false;
    expect(await requestReset("member@example.com")).toEqual({ status: 503, body: { error: "email_unavailable" } });
    expect(await db().prepare("SELECT email FROM password_reset_codes").first()).toBeNull();
  });

  it("信沒寄出去:收回這組碼,馬上可以再寄", async () => {
    await addUser("flaky@example.com", "guest");
    mail.result = { ok: false, error: "provider_error" };
    await requestReset("flaky@example.com");
    mail.result = { ok: true, id: "m2" };
    expect((await requestReset("flaky@example.com")).status).toBe(200);
  });

  it("同一個 Email 每小時最多 5 封;同一個 IP 每小時最多 20 次", async () => {
    await addUser("busy@example.com", "guest");
    for (let i = 0; i < RESET_LIMITS.requestPerEmail.limit; i++) {
      expect((await requestReset("busy@example.com")).status).toBe(200);
      await pastCooldown("busy@example.com");
    }
    expect(await requestReset("busy@example.com")).toEqual({ status: 429, body: { error: "rate_limited" } });

    for (let i = 0; i < RESET_LIMITS.requestPerIp.limit; i++) await hitRateLimit(ip, RESET_LIMITS.requestPerIp);
    expect(await requestReset("fresh@example.com")).toEqual({ status: 429, body: { error: "rate_limited" } });
  });

  it("跨站請求 403;placeholder 與格式錯誤的 Email 400", async () => {
    expect((await requestReset("member@example.com", "https://evil.test")).status).toBe(403);
    expect((await requestReset("oauth-line-1a2b3c4d@placeholder.invalid")).body).toEqual({ error: "invalid_email" });
    expect((await requestReset("not-an-email")).body).toEqual({ error: "invalid_email" });
    expect(mail.sent).toHaveLength(0);
  });
});

describe("確認", () => {
  it("換密碼、登出所有裝置、記下 Email 已驗證、在這裡登入、寄「密碼已變更」、觸發 auth:signed-in", async () => {
    const id = await addUser("forgot@example.com", "admin");
    await db().prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('other-device', ?, ?, ?)").bind(id, Date.now() + 60_000, Date.now()).run();
    await requestReset("forgot@example.com");
    const res = await confirmReset({ email: "forgot@example.com", code: lastCode(), password: "brand new pass" });
    expect(res).toEqual({ status: 200, body: { ok: true } });

    const row = await user("forgot@example.com");
    expect(await verifyPassword("brand new pass", row!.password_hash)).toBe(true);
    expect(row!.email_verified_at).toEqual(expect.any(Number));
    expect(await db().prepare("SELECT id FROM sessions WHERE id = 'other-device'").first()).toBeNull();
    expect(await sessionsOf(id)).toBe(1);
    expect(await getSessionUser()).toMatchObject({ id, role: "admin" });
    expect(mail.sent.at(-1)).toMatchObject({ to: "forgot@example.com", subject: "Your password was changed" });
    expect(hookState.events).toEqual([{ userId: id, method: "reset", emailVerified: true }]);
  });

  it("驗證碼錯了說還剩幾次;密碼太短不用掉嘗試次數", async () => {
    await addUser("typo@example.com", "guest");
    await requestReset("typo@example.com");
    expect(await confirmReset({ email: "typo@example.com", code: lastCode(), password: "short" })).toEqual({
      status: 400,
      body: { error: "weak_password" },
    });
    expect(await confirmReset({ email: "typo@example.com", code: wrongCode(), password: "long enough" })).toEqual({
      status: 400,
      body: { error: "code_wrong", attemptsLeft: MAX_ATTEMPTS - 1 },
    });
    expect((await user("typo@example.com"))!.password_hash).toBe("old-hash");
    expect(cookieStore.map.size).toBe(0);
    expect(hookState.events).toHaveLength(0);
  });

  it("拿到碼之後站台才關掉後台人員重設:403,密碼不變", async () => {
    await addUser("admin@example.com", "admin");
    await requestReset("admin@example.com");
    const code = lastCode();
    settingsState.values[STAFF_RESET_SETTING] = false;
    expect(await confirmReset({ email: "admin@example.com", code, password: "takeover pass" })).toEqual({
      status: 403,
      body: { error: "staff_reset_off" },
    });
    expect((await user("admin@example.com"))!.password_hash).toBe("old-hash");
    expect(cookieStore.map.size).toBe(0);
  });

  it("沒帳號的 Email 拿不到可用的碼", async () => {
    await requestReset("ghost@example.com");
    expect(mail.sent).toHaveLength(0);
    expect(await confirmReset({ email: "ghost@example.com", code: "123456", password: "long enough" })).toMatchObject({ status: 400 });
    expect(cookieStore.map.size).toBe(0);
  });

  it("hook 壞掉不擋登入", async () => {
    hookState.explode = true;
    const id = await addUser("sturdy@example.com", "guest");
    await requestReset("sturdy@example.com");
    expect((await confirmReset({ email: "sturdy@example.com", code: lastCode(), password: "long enough" })).status).toBe(200);
    expect(await getSessionUser()).toMatchObject({ id });
    expect(hookState.events).toHaveLength(1);
  });
});

describe("auth:signed-in", () => {
  it("密碼登入:method password,emailVerified false", async () => {
    const id = await addUser("pw@example.com", "editor", { passwordHash: await hashPassword("correct horse") });
    const res = await post(loginRoute, "/api/auth/login", { email: "pw@example.com", password: "correct horse" });
    expect(res.status).toBe(200);
    expect(hookState.events).toEqual([{ userId: id, method: "password", emailVerified: false }]);
  });

  it("密碼錯:不觸發", async () => {
    await addUser("pw@example.com", "editor", { passwordHash: await hashPassword("correct horse") });
    expect((await post(loginRoute, "/api/auth/login", { email: "pw@example.com", password: "wrong horse" })).status).toBe(401);
    expect(hookState.events).toHaveLength(0);
  });
});
