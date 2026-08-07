import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// docs/spec-admin-agent.md §4 的兩個端點,binding-backed 整合測試(miniflare D1,
// 同 test/ai-generate-route.test.ts / test/agent-content-tools.test.ts 慣例)。
//
// 與 test/agent-loop.test.ts 的分工:那一檔用假 registry 直接測 loop 的規則;這一檔
// 走**真的** registry(buildAgentToolRegistry → declarative_extensions 列自動生成的
// CRUD tools)與真的 content provider,所以「write 沒被執行」這件事在這裡是
// 「contents 表裡真的沒有那一列」。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
  getAI: () => undefined,
}));

// requireAuth 由測試控制(pool-workers 無 request-scoped cookies);
// role gating 語意與真實版一致(ROLE_RANK:admin > editor > guest)。rank 表寫在
// factory 內部 —— vi.mock 的 factory 會被提升,引用不到模組頂層的 const。
const authState = vi.hoisted(() => ({
  user: null as null | {
    id: string;
    email: string;
    name: string;
    role: "admin" | "editor" | "guest";
    avatarKey: null;
  },
}));
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  const rank = { admin: 3, editor: 2, guest: 1 } as const;
  return {
    ...actual,
    requireAuth: async (role: "admin" | "editor" | "guest" = "editor") => {
      if (!authState.user) throw new actual.AuthError(401);
      if (rank[authState.user.role] < rank[role]) throw new actual.AuthError(403);
      return authState.user;
    },
  };
});

// loader 全 mock:真實 loader 在 workers pool 載不起來(interpret → next/navigation)。
// enabled 為空 —— declarative extension 的 tools 是從 declarative_extensions 列生成的,
// 不經 loader。
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

// 上游 LLM 由測試腳本控制。route 走 runAgentChat 的預設路徑(handler 內 dynamic
// import @/lib/ai),vi.mock 對 dynamic import 一樣生效。
interface FakeChatResult {
  ok: boolean;
  text?: string;
  toolUses?: { id: string; name: string; input: unknown }[];
  stopReason?: string;
  error?: string;
  model?: string;
}
const aiState = vi.hoisted(() => ({
  results: [] as FakeChatResult[],
  calls: [] as unknown[],
}));
vi.mock("@/lib/ai", () => {
  const next = (opts: unknown): FakeChatResult => {
    aiState.calls.push(opts);
    return (
      aiState.results[aiState.calls.length - 1] ??
      aiState.results[aiState.results.length - 1] ?? {
        ok: true,
        text: "",
        toolUses: [],
        stopReason: "end_turn",
      }
    );
  };
  return {
    chatAiWithTools: async (opts: unknown) => next(opts),
    // 1.32.0 的串流入口(route 帶 Accept: text/event-stream 時走這條)。逐字切塊
    // 不是這一檔的題目(那由 test/ai-chat-stream.test.ts 釘住),這裡只要「有
    // delta、最後有 result」就足以驗 route 的 SSE framing 與 outcome 一致性。
    chatAiStreamWithTools: async function* (opts: unknown) {
      const result = next(opts);
      if (result.text) yield { type: "text_delta", text: result.text };
      yield { type: "result", result };
    },
  };
});

import { POST as chatPost } from "../src/app/api/admin/agent/chat/route";
import { POST as executePost } from "../src/app/api/admin/agent/execute/route";
import { invalidateSettingsCache } from "../src/lib/settings";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const ORIGIN = "https://cms.test";
const ADMIN = {
  id: "u-admin",
  email: "admin@test.com",
  name: "Admin",
  role: "admin" as const,
  avatarKey: null,
};
const EDITOR = { ...ADMIN, id: "u-editor", email: "e@test.com", role: "editor" as const };
const GUEST = { ...ADMIN, id: "u-guest", email: "g@test.com", role: "guest" as const };

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

function req(path: string, body: unknown, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

const chatReq = (body: unknown, origin = ORIGIN) =>
  req("/api/admin/agent/chat", body, origin);
const executeReq = (body: unknown, origin = ORIGIN) =>
  req("/api/admin/agent/execute", body, origin);

const HELLO = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS agent_audit (id TEXT PRIMARY KEY, at INTEGER NOT NULL, user_id TEXT NOT NULL, user_email TEXT NOT NULL, tool TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, args TEXT NOT NULL, ok INTEGER NOT NULL, result TEXT, error TEXT);",
  );
  // 1.34.0:agent loop 每一次上游呼叫都會寫一列用量(src/ext/ai-usage.ts)。
  // 它 fail-open,少了這張表不會讓測試失敗 —— 但會在每一輪對話留下一則
  // console.error,而那正好會蓋掉真正該被看見的錯誤。
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS ai_usage (id TEXT PRIMARY KEY, at INTEGER NOT NULL, feature TEXT NOT NULL, mode TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, user_id TEXT NOT NULL, user_email TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT NOT NULL DEFAULT 'draft', publish_at INTEGER, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(content_id UNINDEXED, type_key UNINDEXED, locale UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, version TEXT NOT NULL, manifest TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS content_revisions (id TEXT PRIMARY KEY, content_id TEXT NOT NULL, type TEXT NOT NULL, slug TEXT, status TEXT NOT NULL, publish_at INTEGER, data TEXT NOT NULL, actor_id TEXT, reason TEXT NOT NULL, created_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM login_attempts;");
  await d1().exec("DELETE FROM agent_audit;");
  await d1().exec("DELETE FROM ai_usage;");
  await d1().exec("DELETE FROM contents;");
  await d1().exec("DELETE FROM content_fts;");
  await d1().exec("DELETE FROM settings;");
  await d1().exec("DELETE FROM declarative_extensions;");
  await d1().exec("DELETE FROM content_revisions;");
  await d1()
    .prepare(
      "INSERT INTO declarative_extensions (id, version, manifest, enabled) VALUES (?1, ?2, ?3, 1)",
    )
    .bind("gallery", "1.0.0", JSON.stringify(MANIFEST))
    .run();
  invalidateSettingsCache();
  authState.user = ADMIN;
  aiState.results = [];
  aiState.calls = [];
});

async function countRows(table: string): Promise<number> {
  const row = await d1()
    .prepare(`SELECT count(*) AS n FROM ${table}`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function auditRows(): Promise<
  {
    tool: string;
    kind: string;
    source: string;
    ok: number;
    user_id: string;
    user_email: string;
    error: string | null;
  }[]
> {
  const res = await d1()
    .prepare("SELECT * FROM agent_audit ORDER BY at, tool")
    .all<{
      tool: string;
      kind: string;
      source: string;
      ok: number;
      user_id: string;
      user_email: string;
      error: string | null;
    }>();
  return res.results;
}

// ============================================================ /chat guards

describe("POST /api/admin/agent/chat — guards(spec §1.1 admin-only)", () => {
  it("403 on cross-origin", async () => {
    expect((await chatPost(chatReq(HELLO, "https://evil.test"))).status).toBe(403);
  });

  it("401 unauthenticated", async () => {
    authState.user = null;
    expect((await chatPost(chatReq(HELLO))).status).toBe(401);
  });

  it("403 for editor and guest", async () => {
    authState.user = EDITOR;
    expect((await chatPost(chatReq(HELLO))).status).toBe(403);
    authState.user = GUEST;
    expect((await chatPost(chatReq(HELLO))).status).toBe(403);
  });

  it("400 on malformed bodies (zod .strict())", async () => {
    for (const body of [
      {},
      { messages: [] },
      { messages: [{ role: "system", content: [{ type: "text", text: "x" }] }] },
      { messages: [{ role: "user", content: [] }] },
      { messages: [{ role: "user", content: [{ type: "bogus" }] }] },
      { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }], nope: 1 },
      { messages: [{ role: "user", content: [{ type: "text", text: "x", extra: 1 }] }] },
    ]) {
      expect((await chatPost(chatReq(body))).status).toBe(400);
    }
  });

  it("429 after exceeding the rate limit", async () => {
    for (let i = 0; i < 20; i++) {
      expect((await chatPost(chatReq(HELLO))).status).toBe(200);
    }
    expect((await chatPost(chatReq(HELLO))).status).toBe(429);
  });
});

// ============================================================ /chat 鐵律

describe("POST /api/admin/agent/chat — 確認制(真 registry + 真 provider)", () => {
  it("LLM 要求呼叫自動生成的 create tool → 提案,contents 表沒有新列,audit 沒有執行列", async () => {
    aiState.results = [
      {
        ok: true,
        text: "好,我來建一筆。",
        toolUses: [
          {
            id: "tu-1",
            name: "content.gallery_item.create",
            input: { data: { title: "新照片" } },
          },
        ],
        stopReason: "tool_use",
      },
    ];

    const res = await chatPost(chatReq({ messages: HELLO.messages }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      proposal: { toolName: string; toolUseId: string; args: unknown; summary: string };
      appended: unknown[];
    };
    expect(body.status).toBe("proposal");
    expect(body.proposal.toolName).toBe("content.gallery_item.create");
    expect(body.proposal.toolUseId).toBe("tu-1");
    expect(body.proposal.args).toEqual({ data: { title: "新照片" } });
    expect(body.proposal.summary).toContain("Create a new");

    expect(await countRows("contents")).toBe(0);
    expect(await auditRows()).toHaveLength(0);
    // 只打了一次上游 —— 提案就結束,沒有續 loop
    expect(aiState.calls).toHaveLength(1);
  });

  it("read tool 在 loop 內直接執行並記 audit,write tool 仍然看得到", async () => {
    aiState.results = [
      {
        ok: true,
        text: "",
        toolUses: [
          { id: "tu-1", name: "content.gallery_item.list", input: {} },
        ],
        stopReason: "tool_use",
      },
      { ok: true, text: "目前沒有任何項目。", toolUses: [], stopReason: "end_turn" },
    ];

    const res = await chatPost(chatReq({ messages: HELLO.messages }));
    const body = (await res.json()) as { status: string; text: string };
    expect(body.status).toBe("text");
    expect(body.text).toBe("目前沒有任何項目。");

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: "content.gallery_item.list",
      kind: "read",
      source: "chat",
      ok: 1,
      user_id: ADMIN.id,
      user_email: ADMIN.email,
    });

    // 餵給 LLM 的 tools 包含 write(看得到、永不執行)與 core 內建 read
    const names = (
      aiState.calls[0] as { tools: { name: string }[] }
    ).tools.map((t) => t.name);
    expect(names).toContain("content.gallery_item.create");
    expect(names).toContain("content.gallery_item.delete");
    expect(names).toContain("core.content.search");
  });

  it("上游不支援工具呼叫 → 專屬錯誤碼透傳", async () => {
    aiState.results = [{ ok: false, error: "tool_use_not_supported" }];
    const res = await chatPost(chatReq({ messages: HELLO.messages }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "error",
      error: "tool_use_not_supported",
    });
  });
});

// ============================================================ /execute

describe("POST /api/admin/agent/execute — guards", () => {
  const VALID = {
    toolName: "content.gallery_item.create",
    args: { data: { title: "確認後才建" } },
  };

  it("403 on cross-origin", async () => {
    expect((await executePost(executeReq(VALID, "https://evil.test"))).status).toBe(403);
  });

  it("401 unauthenticated", async () => {
    authState.user = null;
    expect((await executePost(executeReq(VALID))).status).toBe(401);
    expect(await countRows("contents")).toBe(0);
  });

  it("403 for editor and guest — 沒有 admin 就沒有執行", async () => {
    authState.user = EDITOR;
    expect((await executePost(executeReq(VALID))).status).toBe(403);
    authState.user = GUEST;
    expect((await executePost(executeReq(VALID))).status).toBe(403);
    expect(await countRows("contents")).toBe(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it("400 on malformed bodies", async () => {
    for (const body of [{}, { toolName: "" }, { ...VALID, nope: 1 }]) {
      expect((await executePost(executeReq(body))).status).toBe(400);
    }
  });

  it("429 after exceeding the rate limit", async () => {
    for (let i = 0; i < 30; i++) {
      const res = await executePost(
        executeReq({ toolName: "content.gallery_item.list", args: {} }),
      );
      expect(res.status).toBe(200);
    }
    expect(
      (await executePost(executeReq({ toolName: "content.gallery_item.list", args: {} })))
        .status,
    ).toBe(429);
  });
});

describe("POST /api/admin/agent/execute — 執行與稽核", () => {
  it("成功:寫入真的發生,audit 記 source=execute / kind=write / who", async () => {
    const res = await executePost(
      executeReq({
        toolName: "content.gallery_item.create",
        args: { data: { title: "確認後才建" } },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      toolName: string;
      result: { id: string; data: Record<string, unknown> };
    };
    expect(body.ok).toBe(true);
    expect(body.toolName).toBe("content.gallery_item.create");
    expect(body.result.data.title).toBe("確認後才建");
    expect(await countRows("contents")).toBe(1);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: "content.gallery_item.create",
      kind: "write",
      source: "execute",
      ok: 1,
      user_id: ADMIN.id,
      user_email: ADMIN.email,
    });
  });

  it("不存在的 tool → 400 unknown_tool,不記 audit", async () => {
    const res = await executePost(
      executeReq({ toolName: "content.nope.create", args: {} }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "unknown_tool" });
    expect(await auditRows()).toHaveLength(0);
  });

  it("args 驗不過 → 400 invalid_args,什麼都沒寫進 contents,但 audit 記下這次嘗試", async () => {
    const res = await executePost(
      executeReq({
        toolName: "content.gallery_item.create",
        // title 必填、且 bogus 是幻覺欄位(schema 是 .strict())
        args: { data: { bogus: 1 } },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string; issues: string[] };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("invalid_args");
    expect(body.issues.join(" ")).toContain("data");
    expect(await countRows("contents")).toBe(0);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ok).toBe(0);
    expect(rows[0]!.error).toContain("invalid_args");
  });

  it("執行時失敗 → 200 透傳 ok:false,audit 記 ok=0", async () => {
    const res = await executePost(
      executeReq({ toolName: "content.gallery_item.delete", args: { id: "nope" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("not_found");

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: 0, kind: "write", source: "execute" });
  });

  it("/chat 的提案原樣送進 /execute 就會執行(前端不必改形狀)", async () => {
    aiState.results = [
      {
        ok: true,
        text: "",
        toolUses: [
          {
            id: "tu-1",
            name: "content.gallery_item.create",
            input: { data: { title: "端到端" }, status: "published" },
          },
        ],
        stopReason: "tool_use",
      },
    ];
    const chatRes = await chatPost(chatReq({ messages: HELLO.messages }));
    const chatBody = (await chatRes.json()) as {
      proposal: { toolName: string; args: unknown };
    };
    expect(await countRows("contents")).toBe(0);

    const execRes = await executePost(
      executeReq({
        toolName: chatBody.proposal.toolName,
        args: chatBody.proposal.args,
      }),
    );
    expect(execRes.status).toBe(200);
    expect(await countRows("contents")).toBe(1);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("execute");
  });
});

// ==================================================== /chat SSE(1.32.0)

// docs/spec-admin-agent.md §3.1:同一段 loop,兩種交出去的方式。這一組測試的核心
// 斷言是**最後那個 outcome 事件的 payload 與 JSON 模式的 body 完全相等** ——
// 前端的 transcript 只由 outcome 組裝(components/admin/agent/transcript.ts),
// 兩種模式分岔的後果是「串流看到的對話」與「重新整理後的對話」不一樣。

interface SseEvent {
  event: string;
  data: unknown;
}

/** 把整份 SSE 回應讀完並解析。刻意整包讀 —— 這裡驗的是 framing 與順序,
 *  「跨 chunk 邊界」由前端的 splitSseFrames 測試負責。 */
async function readSse(res: Response): Promise<SseEvent[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((raw) => raw.trim().length > 0)
    .map((raw) => {
      let event = "message";
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      return { event, data: JSON.parse(dataLines.join("\n")) as unknown };
    });
}

function sseChatReq(body: unknown): Request {
  return new Request(`${ORIGIN}/api/admin/agent/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/agent/chat — SSE(Accept: text/event-stream)", () => {
  const READ_THEN_ANSWER: FakeChatResult[] = [
    {
      ok: true,
      text: "我先查一下。",
      toolUses: [{ id: "tu-1", name: "content.gallery_item.list", input: {} }],
      stopReason: "tool_use",
    },
    { ok: true, text: "目前沒有任何項目。", toolUses: [], stopReason: "end_turn" },
  ];

  it("回 text/event-stream,事件依序送出,最後一個是 outcome", async () => {
    aiState.results = READ_THEN_ANSWER;
    const res = await chatPost(sseChatReq({ messages: HELLO.messages }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await readSse(res);
    expect(events.map((e) => e.event)).toEqual([
      "step",
      "text_delta",
      "tool",
      "tool_done",
      "step",
      "text_delta",
      "outcome",
    ]);
    expect(events[0]!.data).toEqual({ type: "step", step: 1 });
    expect(events[2]!.data).toEqual({
      type: "tool",
      name: "content.gallery_item.list",
    });
    expect(events[3]!.data).toEqual({
      type: "tool_done",
      name: "content.gallery_item.list",
      ok: true,
    });
    expect(events[events.length - 1]!.data).toMatchObject({
      status: "text",
      text: "目前沒有任何項目。",
    });
  });

  it("outcome 的 payload 與 JSON 模式的 body 完全相等", async () => {
    aiState.results = READ_THEN_ANSWER;
    const jsonBody = await (
      await chatPost(chatReq({ messages: HELLO.messages }))
    ).json();

    aiState.calls = [];
    aiState.results = READ_THEN_ANSWER;
    const events = await readSse(
      await chatPost(sseChatReq({ messages: HELLO.messages })),
    );

    const outcome = events[events.length - 1]!;
    expect(outcome.event).toBe("outcome");
    expect(outcome.data).toEqual(jsonBody);
  });

  it("write 提案在 SSE 模式下一樣是提案 —— 鐵律與交付形式無關", async () => {
    aiState.results = [
      {
        ok: true,
        text: "",
        toolUses: [
          {
            id: "tu-1",
            name: "content.gallery_item.create",
            input: { data: { title: "新照片" } },
          },
        ],
        stopReason: "tool_use",
      },
    ];

    const events = await readSse(
      await chatPost(sseChatReq({ messages: HELLO.messages })),
    );
    // 什麼都沒跑:沒有 tool / tool_done 事件。
    expect(events.map((e) => e.event)).toEqual(["step", "outcome"]);
    expect(events[1]!.data).toMatchObject({
      status: "proposal",
      proposal: { toolName: "content.gallery_item.create", toolUseId: "tu-1" },
    });
    expect(await countRows("contents")).toBe(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it("上游錯誤 → 照樣是一個 outcome 事件(不是把串流掐掉)", async () => {
    aiState.results = [{ ok: false, error: "tool_use_not_supported" }];
    const events = await readSse(
      await chatPost(sseChatReq({ messages: HELLO.messages })),
    );
    expect(events[events.length - 1]).toMatchObject({
      event: "outcome",
      data: { status: "error", error: "tool_use_not_supported" },
    });
  });

  it("guard 一律先跑:未登入 / 跨來源 / 壞 body 仍是原來的 JSON 錯誤", async () => {
    authState.user = null;
    expect((await chatPost(sseChatReq(HELLO))).status).toBe(401);
    authState.user = EDITOR;
    expect((await chatPost(sseChatReq(HELLO))).status).toBe(403);
    authState.user = ADMIN;
    expect((await chatPost(sseChatReq({ messages: [] }))).status).toBe(400);
  });

  it("沒帶那個 Accept → 仍是單一 JSON body(既有呼叫端零影響)", async () => {
    aiState.results = READ_THEN_ANSWER;
    const res = await chatPost(chatReq({ messages: HELLO.messages }));
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ status: "text" });
  });
});

// ==================================================== 反問卡(§4.6)

// docs/spec-admin-agent.md §4.6:core.ui.ask 不在 registry 裡,所以這一檔(走**真的**
// registry)是它最誠實的測法 —— 它能被攔下來,靠的不是註冊,而是 loop 認得那個名字。
// 兩條交付路徑各驗一次:outcome 是同一個物件,SSE 只是把它包成最後一個事件。

describe("POST /api/admin/agent/chat — 反問卡(core.ui.ask)", () => {
  const ASK_INPUT = {
    question: "要改哪一篇?",
    options: [
      { value: "cat", label: "貓の日常" },
      { value: "dog", label: "狗の日常", hint: "上週那篇" },
    ],
  };
  const ASKING: FakeChatResult[] = [
    {
      ok: true,
      text: "我不確定是哪一篇。",
      toolUses: [{ id: "tu-ask", name: "core.ui.ask", input: ASK_INPUT }],
      stopReason: "tool_use",
    },
  ];

  it("JSON 模式:status:'ask' 原樣透傳,什麼都沒執行、audit 沒有任何一列", async () => {
    aiState.results = ASKING;
    const res = await chatPost(chatReq({ messages: HELLO.messages }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      ask: unknown;
      toolUseId: string;
      text: string;
      appended: { role: string; content: { type: string; id?: string }[] }[];
    };
    expect(body.status).toBe("ask");
    expect(body.ask).toEqual(ASK_INPUT);
    expect(body.toolUseId).toBe("tu-ask");
    expect(body.text).toBe("我不確定是哪一篇。");
    // appended 的 assistant 只留那一個 tool_use —— 前端據此補 tool_result。
    expect(body.appended).toHaveLength(1);
    expect(
      body.appended[0]!.content.filter((b) => b.type === "tool_use"),
    ).toHaveLength(1);
    expect(await countRows("contents")).toBe(0);
    expect(await auditRows()).toHaveLength(0);
    // 一次上游呼叫就停了。
    expect(aiState.calls).toHaveLength(1);
  });

  it("SSE 模式:沒有 tool 事件,最後一個 outcome 就是那張卡", async () => {
    aiState.results = ASKING;
    const events = await readSse(
      await chatPost(sseChatReq({ messages: HELLO.messages })),
    );

    // 什麼都沒跑 → 沒有 tool / tool_done。
    expect(events.map((e) => e.event)).toEqual(["step", "text_delta", "outcome"]);
    expect(events[events.length - 1]!.data).toMatchObject({
      status: "ask",
      toolUseId: "tu-ask",
      ask: ASK_INPUT,
    });
    expect(await auditRows()).toHaveLength(0);
  });
});
