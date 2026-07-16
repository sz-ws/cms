import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// A(docs/spec-declarative-notify-schedule.md)的 binding-backed 整合測試
// (miniflare D1)。同既有慣例:mock @/lib/cf 讓 db()/getDB() 直接打到
// cloudflare:test 的 env.DB。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// @/lib/email 全 mock:notify.ts 在 handler 內 dynamic import 這個模組(workers pool
// 地雷,見 src/ext/dx/notify.ts 檔頭註解),vi.mock 攔截後真正的 provider/loader 鏈
// 永不載入。
interface CapturedEmail {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
}
const emailState = vi.hoisted(() => ({
  calls: [] as CapturedEmail[],
  shouldThrow: false,
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async (msg: CapturedEmail) => {
    if (emailState.shouldThrow) throw new Error("send failed");
    emailState.calls.push(msg);
    return { ok: true, id: "test-id" };
  }),
}));

// @/ext/loader 全 mock(同 jobs.test.ts 慣例):setSettings 內部 dynamic import 這個
// 模組以分派 settings:saved hook,真實 loader.ts 經 interpret.tsx → DetailView.tsx
// 拉進 next/navigation,workers pool 靜態解析會炸——空 rt.enabled 讓 dispatch 變 no-op。
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

import { buildCrudRoutes } from "../src/ext/dx/crud";
import { CoreContentProvider } from "../src/ext/dx/content-provider";
import { HookBus } from "../src/ext/hooks";
import { setSettings } from "../src/lib/settings";
import type { DeclarativeContentType } from "../src/ext/dx/manifest";
import type { ApiCtx } from "../src/ext/types";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const CONTENTS_DDL =
  "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, slug TEXT, status TEXT NOT NULL DEFAULT 'draft', publish_at INTEGER, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);";
const SETTINGS_DDL =
  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);";
const LOGIN_ATTEMPTS_DDL =
  "CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);";

beforeAll(async () => {
  await d1().exec(CONTENTS_DDL);
  await d1().exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(content_id UNINDEXED, type_key UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');",
  );
  await d1().exec(SETTINGS_DDL);
  await d1().exec(LOGIN_ATTEMPTS_DDL);
});

beforeEach(async () => {
  await d1().exec("DELETE FROM contents;");
  await d1().exec("DELETE FROM content_fts;");
  await d1().exec("DELETE FROM settings;");
  await d1().exec("DELETE FROM login_attempts;");
  emailState.calls = [];
  emailState.shouldThrow = false;
});

const CT: DeclarativeContentType = {
  name: "submission",
  label: "Submission",
  public: true,
  notifyOnCreate: true,
  fields: [
    { key: "name", type: "text" },
    { key: "email", type: "text" },
  ],
};

/** 最小 ApiCtx stub:crud.ts 的 provider() helper 只讀 ctx.services.providers.get()。 */
function makeCtx(): ApiCtx {
  const provider = new CoreContentProvider(new HookBus());
  return {
    user: undefined,
    services: {
      providers: { get: () => provider },
    },
  } as unknown as ApiCtx;
}

function postRoute(ct: DeclarativeContentType) {
  const routes = buildCrudRoutes("contact", ct);
  const route = routes.find((r) => r.method === "POST" && r.path === "submission");
  if (!route) throw new Error("POST route not found");
  return route;
}

function postReq(body: Record<string, unknown>): Request {
  return new Request("https://cms.test/api/ext/contact/submission", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function countContents(): Promise<number> {
  const row = await d1()
    .prepare("SELECT count(*) AS n FROM contents")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("notifyOnCreate — public create best-effort email (spec test 1-4)", () => {
  it("1. sends an email when public + notifyOnCreate + core.notifyEmail are all set", async () => {
    await setSettings({ "core.notifyEmail": "owner@example.com" });
    const res = await postRoute(CT).handler(
      postReq({ name: "Ada", email: "ada@example.com" }),
      {},
      makeCtx(),
    );
    expect(res.status).toBe(201);
    expect(emailState.calls).toHaveLength(1);
    expect(emailState.calls[0].to).toBe("owner@example.com");
    expect(emailState.calls[0].subject).toMatch(/submission/i);
    expect(emailState.calls[0].text).toContain("name: Ada");
    expect(emailState.calls[0].text).toContain("email: ada@example.com");
  });

  it("2a. skips silently when core.notifyEmail is empty", async () => {
    const res = await postRoute(CT).handler(
      postReq({ name: "Ada", email: "ada@example.com" }),
      {},
      makeCtx(),
    );
    expect(res.status).toBe(201);
    expect(emailState.calls).toHaveLength(0);
  });

  it("2b. skips silently when notifyOnCreate is not declared", async () => {
    await setSettings({ "core.notifyEmail": "owner@example.com" });
    const ctNoNotify: DeclarativeContentType = { ...CT, notifyOnCreate: undefined };
    const res = await postRoute(ctNoNotify).handler(
      postReq({ name: "Ada", email: "ada@example.com" }),
      {},
      makeCtx(),
    );
    expect(res.status).toBe(201);
    expect(emailState.calls).toHaveLength(0);
  });

  it("3. still returns 201 when sendEmail throws (best-effort, error is logged)", async () => {
    await setSettings({ "core.notifyEmail": "owner@example.com" });
    emailState.shouldThrow = true;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await postRoute(CT).handler(
      postReq({ name: "Ada", email: "ada@example.com" }),
      {},
      makeCtx(),
    );
    expect(res.status).toBe(201);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("4. honeypot hit: silent 201, no entry created, no email sent", async () => {
    await setSettings({ "core.notifyEmail": "owner@example.com" });
    const res = await postRoute(CT).handler(
      postReq({ name: "Ada", email: "ada@example.com", _hp: "bot" }),
      {},
      makeCtx(),
    );
    expect(res.status).toBe(201);
    expect(emailState.calls).toHaveLength(0);
    expect(await countContents()).toBe(0);
  });

  it("does not notify on non-public content types (admin create)", async () => {
    await setSettings({ "core.notifyEmail": "owner@example.com" });
    const adminCt: DeclarativeContentType = { ...CT, public: false };
    const res = await postRoute(adminCt).handler(
      postReq({ name: "Ada", email: "ada@example.com" }),
      {},
      makeCtx(),
    );
    expect(res.status).toBe(201);
    expect(emailState.calls).toHaveLength(0);
  });
});
