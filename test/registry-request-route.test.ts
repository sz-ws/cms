import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";

// 1.56.0 付費插件協定:POST /api/registry/request(商店的「申請使用」)。
//   - source 必須完全等於已設定的來源,否則 400 unknown_source,不對外連線
//   - 伺服器帶該來源的 token 與 X-Registry-Protocol: 1 POST 到 `<source>/requests`
//   - 聯絡資料勾了才送,而且取自登入的帳號;沒寫留言就不送 note
//   - 不跟隨 redirect(連同一台主機也不跟):3xx 一律 502 request_failed
//   - registry 的回應翻成商店看得懂的:202 / 404 不收 / 409 已開通 / 401·403 金鑰失效
//   - 每人每分鐘 5 次
// registry 以 stub 的 fetch 代替。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));
const authState = vi.hoisted(() => ({ id: "u-req-1" }));
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAuth: async () => ({ id: authState.id, email: "owner@example.com", name: "王小明", role: "admin" as const }),
  };
});
vi.mock("@/lib/security", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/security")>();
  return { ...actual, assertSameOrigin: () => {} };
});

const SOURCE = "https://registry.example.com";
vi.mock("@/lib/settings", () => ({
  getSetting: async () => [{ url: "https://registry.example.com" }],
  getRegistryTokenMap: async () => ({ "https://registry.example.com": "tok-123" }),
}));

import { POST } from "../src/app/api/registry/request/route";

const d1 = () => (env as { DB: D1Database }).DB;

type Call = { url: string; init: RequestInit };

function serve(reply: () => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return reply();
    }),
  );
  return calls;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const post = (body: Record<string, unknown>) =>
  POST(
    new Request("https://cms.test/api/registry/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

let n = 0;
beforeAll(async () => {
  await d1()
    .prepare(
      "CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);",
    )
    .run();
});
beforeEach(() => {
  // 每個測試一位新的管理員:每分鐘 5 次的額度互不影響。
  authState.id = `u-req-${++n}`;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("where the request goes", () => {
  it("a source that is not configured is refused without calling anyone", async () => {
    const calls = serve(() => json(202, {}));
    const res = await post({ source: "https://evil.example.com", extension: "session-replay" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown_source" });
    // 差一個結尾斜線也不算同一個來源。
    expect((await post({ source: `${SOURCE}/`, extension: "session-replay" })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("posts to <source>/requests with the source's token and the protocol header", async () => {
    const calls = serve(() => json(202, {}));
    const res = await post({ source: SOURCE, extension: "session-replay" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe("https://registry.example.com/requests");
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("manual");
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe("token tok-123");
    expect(headers.get("x-registry-protocol")).toBe("1");
    expect(JSON.parse(String(call.init.body))).toEqual({ extension: "session-replay" });
  });

  it("the note goes when written; name and email only when ticked, and from the signed-in account", async () => {
    const calls = serve(() => json(202, { message: "\u001b[31m收到了\u001b[0m,兩天內聯絡你" }));
    const res = await post({ source: SOURCE, extension: "session-replay", note: "  想先試用一個月 ", contact: true });
    expect(await res.json()).toEqual({ ok: true, message: "收到了,兩天內聯絡你" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      extension: "session-replay",
      note: "想先試用一個月",
      contact: { name: "王小明", email: "owner@example.com" },
    });
    await post({ source: SOURCE, extension: "session-replay", note: "", contact: false });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ extension: "session-replay" });
  });

  it("the browser cannot choose what contact details are sent", async () => {
    serve(() => json(202, {}));
    const res = await post({
      source: SOURCE,
      extension: "session-replay",
      contact: { name: "someone else", email: "x@evil.example.com" },
    });
    expect(res.status).toBe(400);
  });

  it("a note over 500 characters is refused before anything is sent", async () => {
    const calls = serve(() => json(202, {}));
    const res = await post({ source: SOURCE, extension: "session-replay", note: "字".repeat(501) });
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });
});

describe("redirects are never followed", () => {
  it("a cross-host redirect is refused", async () => {
    const calls = serve(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.net/requests" } }));
    const res = await post({ source: SOURCE, extension: "session-replay", contact: true });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "request_failed" });
    expect(calls).toHaveLength(1);
  });

  it("so is a same-host one", async () => {
    const calls = serve(() => new Response(null, { status: 307, headers: { location: "/v2/requests" } }));
    expect((await post({ source: SOURCE, extension: "session-replay" })).status).toBe(502);
    expect(calls).toHaveLength(1);
  });
});

describe("what the registry answered", () => {
  const cases: [string, () => Response, number, unknown][] = [
    ["404: this registry takes no requests", () => json(404, { error: "not_found" }), 404, { error: "requests_not_accepted" }],
    ["409 already_granted", () => json(409, { error: "already_granted" }), 409, { error: "already_granted" }],
    ["413", () => json(413, { error: "too_large" }), 413, { error: "payload_too_large" }],
    ["429", () => json(429, { error: "rate_limited" }), 429, { error: "rate_limited" }],
    ["401: the key is not valid", () => json(401, { error: "unauthorized" }), 502, { error: "source_key_invalid" }],
    ["403: the key is not valid", () => json(403, {}), 502, { error: "source_key_invalid" }],
    ["500", () => new Response("boom", { status: 500 }), 502, { error: "request_failed" }],
  ];
  for (const [name, reply, status, body] of cases) {
    it(name, async () => {
      serve(reply);
      const res = await post({ source: SOURCE, extension: "session-replay" });
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(body);
    });
  }

  it("a network failure is a plain failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    const res = await post({ source: SOURCE, extension: "session-replay" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "request_failed" });
  });
});

describe("courtesy limit", () => {
  it("five a minute per admin", async () => {
    serve(() => json(202, {}));
    for (let i = 0; i < 5; i++) {
      expect((await post({ source: SOURCE, extension: "session-replay" })).status).toBe(202);
    }
    const res = await post({ source: SOURCE, extension: "session-replay" });
    expect(res.status).toBe(429);
  });

  it("bad input is refused", async () => {
    serve(() => json(202, {}));
    expect((await post({ source: SOURCE, extension: "../../etc" })).status).toBe(400);
    expect((await post({ source: SOURCE })).status).toBe(400);
    expect((await post({ source: SOURCE, extension: "session-replay", extra: 1 })).status).toBe(400);
  });
});
