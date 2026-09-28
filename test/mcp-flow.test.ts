import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// AI 連線的完整流程,binding-backed(miniflare D1)。走真的路由、真的 session、真的
// agent registry(declarative_extensions 列自動生成的 content.* tools)與真的 content
// provider —— 「只能查看的連線寫不進去」在這裡是「contents 表裡真的沒有那一列」。
//
//   登記 → 同意(簽票 → POST /api/oauth/authorize)→ 換權杖 → MCP initialize / tools/list /
//   tools/call(read)→ 只能查看的連線呼叫 write 被拒 → 可以修改的連線寫入 → refresh
//   rotation → 後台中斷連線 → 401。另含探索文件、401 標頭、開關、降級。
//
// 同意畫面本身(page.tsx)在 workers pool 載不起來(next/navigation);它做的兩件事 ——
// checkAuthorizeRequest 與 issueConsentTicket —— 這裡直接呼叫同一支函式。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
  getAI: () => undefined,
}));

// session cookie 由測試控制(pool-workers 沒有 request-scoped cookies);其餘走真的 auth。
const cookieState = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "session" && cookieState.token ? { value: cookieState.token } : undefined),
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(),
}));

// loader 全 mock(同 test/agent-routes.test.ts):真的 loader 在 workers pool 載不起來。
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const hooks = new HookBus();
  return {
    getExtRuntime: async () => ({
      enabled: [],
      all: [],
      hooks,
      byId: () => undefined,
      isCompatible: () => true,
      unavailableById: new Map(),
    }),
  };
});

import { createSession } from "../src/lib/auth";
import { invalidateSettingsCache } from "../src/lib/settings";
import { pkceChallenge } from "../src/lib/mcp/crypto";
import { getClient } from "../src/lib/mcp/clients";
import { checkAuthorizeRequest, issueConsentTicket } from "../src/lib/mcp/consent";
import { POST as mcpPost, GET as mcpGet } from "../src/app/api/mcp/route";
import { POST as registerPost } from "../src/app/api/oauth/register/route";
import { POST as tokenPost } from "../src/app/api/oauth/token/route";
import { POST as revokePost } from "../src/app/api/oauth/revoke/route";
import { POST as authorizePost } from "../src/app/api/oauth/authorize/route";
import { DELETE as disconnectDelete } from "../src/app/api/ai-connections/[id]/route";
import { GET as prmGet } from "../src/app/.well-known/oauth-protected-resource/[[...path]]/route";
import { GET as asGet } from "../src/app/.well-known/oauth-authorization-server/[[...path]]/route";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const ORIGIN = "https://cms.test";
const MCP_URL = `${ORIGIN}/api/mcp`;
const REDIRECT = "https://app.example/oauth/callback";
const VERIFIER = "v".repeat(30) + "-._~" + "0123456789abcdef";

const MANIFEST = {
  kind: "declarative",
  id: "gallery",
  name: "Gallery",
  version: "1.0.0",
  coreApi: "^1.28.0",
  contentTypes: [
    {
      name: "item",
      label: "Gallery item",
      slugField: "title",
      fields: [
        { key: "title", type: "text", required: true },
        { key: "note", type: "text" },
      ],
    },
  ],
};

const TABLES = [
  "CREATE TABLE IF NOT EXISTS staff_roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, access TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT, staff_role_id TEXT, email_verified_at INTEGER);",
  "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS agent_audit (id TEXT PRIMARY KEY, at INTEGER NOT NULL, user_id TEXT NOT NULL, user_email TEXT NOT NULL, tool TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, args TEXT NOT NULL, ok INTEGER NOT NULL, result TEXT, error TEXT, app TEXT);",
  "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT NOT NULL DEFAULT 'draft', publish_at INTEGER, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  "CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(content_id UNINDEXED, type_key UNINDEXED, locale UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');",
  "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, version TEXT NOT NULL, manifest TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, scripts_approval TEXT);",
  "CREATE TABLE IF NOT EXISTS content_revisions (id TEXT PRIMARY KEY, content_id TEXT NOT NULL, type TEXT NOT NULL, slug TEXT, status TEXT NOT NULL, publish_at INTEGER, data TEXT NOT NULL, actor_id TEXT, reason TEXT NOT NULL, created_at INTEGER NOT NULL);",
  // migrations/0025_mcp_connections.sql 的鏡像。
  "CREATE TABLE IF NOT EXISTS mcp_clients (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, secret_hash TEXT, created_at INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS mcp_grants (id TEXT PRIMARY KEY NOT NULL, client_id TEXT NOT NULL, user_id TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER);",
  "CREATE UNIQUE INDEX IF NOT EXISTS mcp_grants_client_user_idx ON mcp_grants (client_id, user_id);",
  "CREATE TABLE IF NOT EXISTS mcp_codes (code_hash TEXT PRIMARY KEY NOT NULL, grant_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, expires_at INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS mcp_tokens (token_hash TEXT PRIMARY KEY NOT NULL, grant_id TEXT NOT NULL, kind TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);",
];

const CLEAR = [
  "mcp_tokens",
  "mcp_codes",
  "mcp_grants",
  "mcp_clients",
  "sessions",
  "users",
  "login_attempts",
  "settings",
  "agent_audit",
  "contents",
  "content_fts",
  "content_revisions",
  "declarative_extensions",
];

beforeAll(async () => {
  for (const sql of TABLES) await d1().exec(sql);
});

async function setSetting(key: string, value: unknown): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key, JSON.stringify(value), Date.now())
    .run();
  invalidateSettingsCache();
}

async function seedUser(id: string, role: "admin" | "editor" | "guest"): Promise<void> {
  await d1()
    .prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?1, ?2, 'x', ?3, ?4, ?5)")
    .bind(id, `${id}@example.test`, id === "u-admin" ? "Owner" : id, role, Date.now())
    .run();
}

async function signIn(userId: string): Promise<void> {
  cookieState.token = await createSession(userId);
}

beforeEach(async () => {
  for (const table of CLEAR) await d1().exec(`DELETE FROM ${table};`);
  await d1()
    .prepare("INSERT INTO declarative_extensions (id, version, manifest, enabled) VALUES (?1, ?2, ?3, 1)")
    .bind("gallery", "1.0.0", JSON.stringify(MANIFEST))
    .run();
  await setSetting("core.mcp.enabled", true);
  await setSetting("core.siteTitle", "Test Site");
  await seedUser("u-admin", "admin");
  await seedUser("u-editor", "editor");
  await signIn("u-admin");
});

// ---- request helpers ----

function jsonPost(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function formPost(path: string, form: Record<string, string>): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

async function register(name = "Test App"): Promise<string> {
  const res = await registerPost(
    jsonPost("/api/oauth/register", {
      client_name: name,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { client_id: string; client_secret?: string };
  expect(body.client_secret).toBeUndefined();
  return body.client_id;
}

/** 同意畫面做的事(驗請求 + 簽票),再按下按鈕。回傳導回 App 的網址。 */
async function consent(
  clientId: string,
  decision: "approve" | "deny",
  access: "read" | "write",
  origin = ORIGIN,
): Promise<Response> {
  const client = await getClient(clientId);
  const check = checkAuthorizeRequest(
    {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: await pkceChallenge(VERIFIER),
      code_challenge_method: "S256",
      state: "st-1",
      resource: MCP_URL,
    },
    client,
    ORIGIN,
  );
  if (!check.ok) throw new Error(`authorize request rejected: ${JSON.stringify(check)}`);
  const ticket = await issueConsentTicket(check.request, "u-admin", cookieState.token ?? "signed-out", Date.now());
  return authorizePost(jsonPost("/api/oauth/authorize", { ticket, decision, access }, { Origin: origin }));
}

async function approvedCode(clientId: string, access: "read" | "write"): Promise<string> {
  const res = await consent(clientId, "approve", access);
  expect(res.status).toBe(200);
  const { redirect } = (await res.json()) as { redirect: string };
  const url = new URL(redirect);
  expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
  expect(url.searchParams.get("state")).toBe("st-1");
  expect(url.searchParams.get("iss")).toBe(ORIGIN);
  const code = url.searchParams.get("code");
  expect(code).toBeTruthy();
  return code!;
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

async function exchange(clientId: string, code: string, verifier = VERIFIER): Promise<Response> {
  return tokenPost(
    formPost("/api/oauth/token", {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: MCP_URL,
    }),
  );
}

async function connect(access: "read" | "write", name?: string): Promise<{ clientId: string; tokens: Tokens }> {
  const clientId = await register(name);
  const res = await exchange(clientId, await approvedCode(clientId, access));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return { clientId, tokens: (await res.json()) as Tokens };
}

let rpcId = 0;
async function rpc(token: string | null, method: string, params?: unknown, headers: Record<string, string> = {}) {
  const res = await mcpPost(
    jsonPost(
      "/api/mcp",
      { jsonrpc: "2.0", id: ++rpcId, method, ...(params === undefined ? {} : { params }) },
      { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ),
  );
  return res;
}

async function rpcResult<T>(token: string, method: string, params?: unknown): Promise<T> {
  const res = await rpc(token, method, params);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: T; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result as T;
}

interface ToolDef {
  name: string;
  inputSchema: { type?: string };
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
}
interface CallResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

async function countRows(table: string): Promise<number> {
  const row = await d1().prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

async function auditRows() {
  return (
    await d1()
      .prepare("SELECT tool, kind, source, app, ok, user_id FROM agent_audit ORDER BY at")
      .all<{ tool: string; kind: string; source: string; app: string | null; ok: number; user_id: string }>()
  ).results;
}

// ============================================================ 探索與 401

describe("discovery and the 401 challenge", () => {
  it("serves both metadata documents at the root and at the /api/mcp suffix", async () => {
    for (const path of [undefined, ["api", "mcp"]]) {
      const prm = await prmGet(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`), {
        params: Promise.resolve({ path }),
      });
      expect(prm.status).toBe(200);
      expect(await prm.json()).toMatchObject({
        resource: MCP_URL,
        authorization_servers: [ORIGIN],
        resource_name: "Test Site",
      });
      const as = await asGet(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), {
        params: Promise.resolve({ path }),
      });
      expect(as.status).toBe(200);
      expect(await as.json()).toMatchObject({ issuer: ORIGIN, code_challenge_methods_supported: ["S256"] });
    }
    const other = await prmGet(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/x`), {
      params: Promise.resolve({ path: ["x"] }),
    });
    expect(other.status).toBe(404);
  });

  it("uses core.siteUrl as the origin when it is set", async () => {
    await setSetting("core.siteUrl", "https://www.shop.example/");
    const prm = await prmGet(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`), {
      params: Promise.resolve({}),
    });
    expect(await prm.json()).toMatchObject({ resource: "https://www.shop.example/api/mcp" });
  });

  it("401 + WWW-Authenticate pointing at the resource metadata, with and without a token", async () => {
    const none = await rpc(null, "initialize", {});
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
    );
    const bad = await rpc("mcp_at_nope", "initialize", {});
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("GET is 405", () => {
    expect(mcpGet().status).toBe(405);
  });

  it("everything answers 404 while the switch is off (the default)", async () => {
    await d1().exec("DELETE FROM settings;");
    invalidateSettingsCache();
    expect((await prmGet(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`), { params: Promise.resolve({}) })).status).toBe(404);
    expect((await asGet(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), { params: Promise.resolve({}) })).status).toBe(404);
    expect((await rpc(null, "initialize", {})).status).toBe(404);
    expect(
      (await registerPost(jsonPost("/api/oauth/register", { redirect_uris: [REDIRECT] }))).status,
    ).toBe(404);
  });
});

// ============================================================ 登記

describe("registration", () => {
  it("rejects redirect URIs that could become an open redirect", async () => {
    for (const uri of ["http://app.example/cb", "javascript:alert(1)", "https://app.example/cb#x"]) {
      const res = await registerPost(jsonPost("/api/oauth/register", { redirect_uris: [uri] }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_redirect_uri" });
    }
  });

  it("confidential clients get a secret once and must present it", async () => {
    const res = await registerPost(jsonPost("/api/oauth/register", { client_name: "Server App", redirect_uris: [REDIRECT] }));
    const body = (await res.json()) as { client_id: string; client_secret: string; token_endpoint_auth_method: string };
    expect(body.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(body.client_secret).toMatch(/^mcp_cs_/);
    const stored = await d1().prepare("SELECT secret_hash FROM mcp_clients WHERE id = ?1").bind(body.client_id).first<{ secret_hash: string }>();
    expect(stored?.secret_hash).not.toContain(body.client_secret);

    const code = await approvedCode(body.client_id, "read");
    const noSecret = await exchange(body.client_id, code);
    expect(noSecret.status).toBe(401);
    expect(await noSecret.json()).toMatchObject({ error: "invalid_client" });

    const code2 = await approvedCode(body.client_id, "read");
    const basic = btoa(`${encodeURIComponent(body.client_id)}:${encodeURIComponent(body.client_secret)}`);
    const ok = await tokenPost(
      new Request(`${ORIGIN}/api/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code2,
          redirect_uri: REDIRECT,
          code_verifier: VERIFIER,
        }).toString(),
      }),
    );
    expect(ok.status).toBe(200);
  });

  it("is rate limited per address", async () => {
    for (let i = 0; i < 10; i++) await register(`App ${i}`);
    const res = await registerPost(jsonPost("/api/oauth/register", { redirect_uris: [REDIRECT] }));
    expect(res.status).toBe(429);
  });
});

// ============================================================ 同意

describe("consent (POST /api/oauth/authorize)", () => {
  it("refuses a cross-site post", async () => {
    const clientId = await register();
    expect((await consent(clientId, "approve", "read", "https://evil.example")).status).toBe(403);
  });

  it("refuses a ticket signed for another session or tampered with", async () => {
    const clientId = await register();
    const client = await getClient(clientId);
    const check = checkAuthorizeRequest(
      {
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: await pkceChallenge(VERIFIER),
        code_challenge_method: "S256",
      },
      client,
      ORIGIN,
    );
    if (!check.ok) throw new Error("expected ok");
    const foreign = await issueConsentTicket(check.request, "u-admin", "someone-elses-session", Date.now());
    const res = await authorizePost(
      jsonPost("/api/oauth/authorize", { ticket: foreign, decision: "approve", access: "write" }, { Origin: ORIGIN }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "expired" });
    expect(await countRows("mcp_grants")).toBe(0);
  });

  it("deny sends access_denied back with the state and creates nothing", async () => {
    const clientId = await register();
    const res = await consent(clientId, "deny", "write");
    const { redirect } = (await res.json()) as { redirect: string };
    const url = new URL(redirect);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("st-1");
    expect(url.searchParams.get("code")).toBeNull();
    expect(await countRows("mcp_grants")).toBe(0);
  });

  it("only admins can approve", async () => {
    const clientId = await register();
    await signIn("u-editor");
    expect((await consent(clientId, "approve", "read")).status).toBe(403);
    cookieState.token = null;
    expect((await consent(clientId, "approve", "read")).status).toBe(401);
  });
});

// ============================================================ 權杖

describe("token endpoint", () => {
  it("codes are single-use and need the right PKCE verifier", async () => {
    const clientId = await register();
    const code = await approvedCode(clientId, "read");
    const wrong = await exchange(clientId, code, "w".repeat(50));
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });
    // 驗錯一次,這個碼就用掉了。
    expect((await exchange(clientId, code)).status).toBe(400);

    const code2 = await approvedCode(clientId, "read");
    const ok = await exchange(clientId, code2);
    expect(ok.status).toBe(200);
    const tokens = (await ok.json()) as Tokens;
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "read" });
    expect(tokens.access_token).toMatch(/^mcp_at_/);
    expect(tokens.refresh_token).toMatch(/^mcp_rt_/);
    const replay = await exchange(clientId, code2);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });

    // 只存雜湊。
    const stored = await d1().prepare("SELECT token_hash FROM mcp_tokens").all<{ token_hash: string }>();
    expect(stored.results.map((r) => r.token_hash)).not.toContain(tokens.access_token);
  });

  it("a code issued to one app cannot be redeemed by another", async () => {
    const a = await register("A");
    const b = await register("B");
    const code = await approvedCode(a, "read");
    const res = await exchange(b, code);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("unknown grant types and resources are refused", async () => {
    const clientId = await register();
    const res = await tokenPost(formPost("/api/oauth/token", { grant_type: "password", client_id: clientId }));
    expect(await res.json()).toMatchObject({ error: "unsupported_grant_type" });
    const code = await approvedCode(clientId, "read");
    const target = await tokenPost(
      formPost("/api/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        code_verifier: VERIFIER,
        resource: "https://elsewhere.example/api/mcp",
      }),
    );
    expect(await target.json()).toMatchObject({ error: "invalid_target" });
  });
});

// ============================================================ MCP

describe("MCP over a view-only connection", () => {
  it("initialize negotiates the protocol version", async () => {
    const { tokens } = await connect("read");
    const init = await rpcResult<{ protocolVersion: string; capabilities: unknown; serverInfo: { title?: string } }>(
      tokens.access_token,
      "initialize",
      { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    );
    expect(init.protocolVersion).toBe("2025-06-18");
    expect(init.capabilities).toEqual({ tools: { listChanged: false } });
    expect(init.serverInfo.title).toBe("Test Site");
    const old = await rpcResult<{ protocolVersion: string }>(tokens.access_token, "initialize", { protocolVersion: "2025-03-26" });
    expect(old.protocolVersion).toBe("2025-03-26");
    const future = await rpcResult<{ protocolVersion: string }>(tokens.access_token, "initialize", { protocolVersion: "2099-01-01" });
    expect(future.protocolVersion).toBe("2025-11-25");

    const note = await mcpPost(
      jsonPost("/api/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, { Authorization: `Bearer ${tokens.access_token}` }),
    );
    expect(note.status).toBe(202);
    expect(await rpcResult(tokens.access_token, "ping")).toEqual({});
    const unknown = await rpc(tokens.access_token, "resources/list");
    expect(((await unknown.json()) as { error: { code: number } }).error.code).toBe(-32601);
    const badVersion = await rpc(tokens.access_token, "ping", undefined, { "MCP-Protocol-Version": "1999-01-01" });
    expect(badVersion.status).toBe(400);
  });

  it("lists only read tools, with wire-safe names and annotations", async () => {
    const { tokens } = await connect("read");
    const { tools } = await rpcResult<{ tools: ToolDef[] }>(tokens.access_token, "tools/list");
    const names = tools.map((t) => t.name);
    expect(names).toContain("content-gallery_item-list");
    expect(names).toContain("core-content-search");
    expect(names).not.toContain("content-gallery_item-create");
    expect(names.every((n) => /^[a-zA-Z0-9_-]{1,64}$/.test(n))).toBe(true);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    }
  });

  it("calls a read tool and audits it as MCP with the app's name", async () => {
    const { tokens } = await connect("read", "Reader App");
    await d1()
      .prepare(
        "INSERT INTO contents (id, type, locale, translation_group, slug, status, data, created_at, updated_at) VALUES ('c1', 'gallery.item', 'en', 'c1', 'first', 'published', ?1, 1, 1)",
      )
      .bind(JSON.stringify({ title: "First photo" }))
      .run();
    const result = await rpcResult<CallResult>(tokens.access_token, "tools/call", {
      name: "content-gallery_item-list",
      arguments: {},
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("First photo");
    expect(await auditRows()).toEqual([
      { tool: "content.gallery_item.list", kind: "read", source: "mcp", app: "Reader App", ok: 1, user_id: "u-admin" },
    ]);
  });

  it("refuses a write tool: nothing is written and nothing is audited", async () => {
    const { tokens } = await connect("read");
    const result = await rpcResult<CallResult>(tokens.access_token, "tools/call", {
      name: "content-gallery_item-create",
      arguments: { data: { title: "Sneaky" } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("only look things up");
    expect(await countRows("contents")).toBe(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it("an unknown tool is a protocol error", async () => {
    const { tokens } = await connect("read");
    const res = await rpc(tokens.access_token, "tools/call", { name: "nope", arguments: {} });
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32602);
  });
});

describe("MCP over a connection that may make changes", () => {
  it("lists write tools with destructive hints and executes through the audited path", async () => {
    const { tokens } = await connect("write", "Writer App");
    expect(tokens.scope).toBe("read write");
    const { tools } = await rpcResult<{ tools: ToolDef[] }>(tokens.access_token, "tools/list");
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("content-gallery_item-create")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(byName.get("content-gallery_item-delete")?.annotations.destructiveHint).toBe(true);

    const created = await rpcResult<CallResult>(tokens.access_token, "tools/call", {
      name: "content-gallery_item-create",
      arguments: { data: { title: "From the app" } },
    });
    expect(created.isError).toBeUndefined();
    expect(created.content[0].text).toMatch(/^Done: /);
    expect(await countRows("contents")).toBe(1);

    // 驗不過 schema:isError 結果,照樣記一列失敗的稽核(同 /execute)。
    const invalid = await rpcResult<CallResult>(tokens.access_token, "tools/call", {
      name: "content-gallery_item-create",
      arguments: { data: {} },
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toContain("invalid_args");

    expect(await auditRows()).toEqual([
      { tool: "content.gallery_item.create", kind: "write", source: "mcp", app: "Writer App", ok: 1, user_id: "u-admin" },
      { tool: "content.gallery_item.create", kind: "write", source: "mcp", app: "Writer App", ok: 0, user_id: "u-admin" },
    ]);
  });

  it("reconnecting the same app updates its access instead of adding a connection", async () => {
    const clientId = await register();
    await exchange(clientId, await approvedCode(clientId, "write"));
    const res = await exchange(clientId, await approvedCode(clientId, "read"));
    const tokens = (await res.json()) as Tokens;
    expect(await countRows("mcp_grants")).toBe(1);
    const { tools } = await rpcResult<{ tools: ToolDef[] }>(tokens.access_token, "tools/list");
    expect(tools.some((t) => t.name === "content-gallery_item-create")).toBe(false);
  });
});

// ============================================================ refresh / 撤銷

describe("refresh rotation and revocation", () => {
  it("rotates refresh tokens: the old one dies, the new pair works", async () => {
    const { clientId, tokens } = await connect("read");
    const refresh = (token: string) =>
      tokenPost(formPost("/api/oauth/token", { grant_type: "refresh_token", refresh_token: token, client_id: clientId }));

    const res = await refresh(tokens.refresh_token);
    expect(res.status).toBe(200);
    const next = (await res.json()) as Tokens;
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(await rpcResult(next.access_token, "ping")).toEqual({});

    const reuse = await refresh(tokens.refresh_token);
    expect(reuse.status).toBe(400);
    expect(await reuse.json()).toMatchObject({ error: "invalid_grant" });

    // 別的 App 拿不走這把 refresh token。
    const other = await register("Other");
    const stolen = await tokenPost(
      formPost("/api/oauth/token", { grant_type: "refresh_token", refresh_token: next.refresh_token, client_id: other }),
    );
    expect(await stolen.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("disconnecting in Settings kills the tokens at once", async () => {
    const { clientId, tokens } = await connect("write");
    const grant = await d1().prepare("SELECT id FROM mcp_grants").first<{ id: string }>();
    expect(grant).toBeTruthy();

    const crossSite = await disconnectDelete(
      new Request(`${ORIGIN}/api/ai-connections/${grant!.id}`, { method: "DELETE", headers: { Origin: "https://evil.example" } }),
      { params: Promise.resolve({ id: grant!.id }) },
    );
    expect(crossSite.status).toBe(403);

    const res = await disconnectDelete(
      new Request(`${ORIGIN}/api/ai-connections/${grant!.id}`, { method: "DELETE", headers: { Origin: ORIGIN } }),
      { params: Promise.resolve({ id: grant!.id }) },
    );
    expect(res.status).toBe(200);
    expect(await countRows("mcp_grants")).toBe(0);
    expect(await countRows("mcp_tokens")).toBe(0);

    expect((await rpc(tokens.access_token, "ping")).status).toBe(401);
    const refreshed = await tokenPost(
      formPost("/api/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }),
    );
    expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("only admins can disconnect from Settings", async () => {
    await connect("read");
    const grant = await d1().prepare("SELECT id FROM mcp_grants").first<{ id: string }>();
    await signIn("u-editor");
    const res = await disconnectDelete(
      new Request(`${ORIGIN}/api/ai-connections/${grant!.id}`, { method: "DELETE", headers: { Origin: ORIGIN } }),
      { params: Promise.resolve({ id: grant!.id }) },
    );
    expect(res.status).toBe(403);
    expect(await countRows("mcp_grants")).toBe(1);
  });

  it("the app can end the connection itself (RFC 7009)", async () => {
    const { clientId, tokens } = await connect("read");
    const res = await revokePost(formPost("/api/oauth/revoke", { token: tokens.refresh_token, client_id: clientId }));
    expect(res.status).toBe(200);
    expect(await countRows("mcp_grants")).toBe(0);
    expect((await rpc(tokens.access_token, "ping")).status).toBe(401);
  });

  it("an admin who is no longer an admin loses the connection on the next call", async () => {
    const { clientId, tokens } = await connect("write");
    await d1().prepare("UPDATE users SET role = 'editor' WHERE id = 'u-admin'").run();
    expect((await rpc(tokens.access_token, "ping")).status).toBe(401);
    const refreshed = await tokenPost(
      formPost("/api/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }),
    );
    expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("turning the switch off pauses every connection", async () => {
    const { tokens } = await connect("read");
    await setSetting("core.mcp.enabled", false);
    expect((await rpc(tokens.access_token, "ping")).status).toBe(404);
    await setSetting("core.mcp.enabled", true);
    expect((await rpc(tokens.access_token, "ping")).status).toBe(200);
  });
});
