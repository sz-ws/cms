import { describe, it, expect, beforeEach, vi } from "vitest";

// POST /api/export 的守衛與回應契約測試。I/O 全 mock,聚焦 route 自己的責任:
// same-origin、admin gating、參數形狀、下載 header、以及「被拒時一列資料都不會流出」。
// 匯出引擎本體由 test/content-export.test.ts 覆蓋。

const authState = vi.hoisted(() => ({
  user: null as null | {
    id: string;
    email: string;
    name: string;
    role: "admin" | "editor" | "guest";
    avatarKey: string | null;
  },
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

const bindingState = vi.hoisted(() => ({ dbCalls: 0 }));
vi.mock("@/lib/cf", () => ({
  getDB: () => {
    bindingState.dbCalls++;
    return {} as unknown;
  },
  getStorage: () => undefined,
  getEnv: () => ({}),
}));

vi.mock("@/ext/loader", () => ({
  getExtRuntime: async () => ({
    enabled: [
      {
        id: "blog",
        contentTypes: [
          {
            name: "post",
            label: { en: "Posts", "zh-Hant": "文章" },
            fields: [
              { key: "title", type: "text" },
              { key: "body", type: "richtext" },
            ],
          },
        ],
      },
    ],
    all: [],
    byId: () => undefined,
  }),
}));

vi.mock("@/lib/i18n/server", () => ({ getLocale: async () => "en" }));

// 引擎替身:記錄實際收到的參數,並吐出可預測的紀錄流。
const engineState = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
  settingsCalls: 0,
}));
vi.mock("@/lib/content-export", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/content-export")>();
  return {
    ...actual,
    collectExportableSettings: async () => {
      engineState.settingsCalls++;
      return [{ kind: "setting", key: "core.siteTitle", value: "Acme" }];
    },
    exportRecords: async function* (opts: Record<string, unknown>) {
      engineState.calls.push(opts);
      yield opts.meta as never;
      yield {
        kind: "end",
        counts: { settings: 1, media: 0, entries: 0 },
        truncated: { media: false, entries: false },
        resume: null,
      } as never;
    },
  };
});

import { POST } from "../src/app/api/export/route";
import { EXPORT_FORMAT } from "../src/lib/content-export";

const ORIGIN = "https://cms.test";
const ADMIN = {
  id: "u-admin",
  email: "a@test.com",
  name: "A",
  role: "admin" as const,
  avatarKey: null,
};
const EDITOR = { ...ADMIN, id: "u-ed", role: "editor" as const };
const GUEST = { ...ADMIN, id: "u-g", role: "guest" as const };

function req(query = "", origin: string | null = ORIGIN): Request {
  const headers: Record<string, string> = {};
  if (origin) headers.Origin = origin;
  return new Request(`${ORIGIN}/api/export${query}`, { method: "POST", headers });
}

async function lines(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  authState.user = ADMIN;
  engineState.calls = [];
  engineState.settingsCalls = 0;
  bindingState.dbCalls = 0;
});

describe("POST /api/export — who may export", () => {
  it("rejects a missing or foreign Origin before touching any data", async () => {
    expect((await POST(req("", null))).status).toBe(403);
    expect((await POST(req("", "https://evil.test"))).status).toBe(403);
    expect(engineState.calls).toHaveLength(0);
    expect(engineState.settingsCalls).toBe(0);
    expect(bindingState.dbCalls).toBe(0);
  });

  it("rejects anonymous callers with 401 and emits nothing", async () => {
    authState.user = null;
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(engineState.calls).toHaveLength(0);
  });

  it("rejects editor and guest with 403 — export is admin-only", async () => {
    authState.user = EDITOR;
    expect((await POST(req())).status).toBe(403);
    authState.user = GUEST;
    expect((await POST(req())).status).toBe(403);
    expect(engineState.calls).toHaveLength(0);
    expect(engineState.settingsCalls).toBe(0);
  });
});

describe("POST /api/export — parameters", () => {
  it("rejects malformed type / after / mediaCursor with 400", async () => {
    for (const q of [
      "?type=not-a-type",
      "?type=blog.post;DROP",
      "?type=" + encodeURIComponent("blog.*"),
      "?after=" + encodeURIComponent("a b"),
      "?after=" + "x".repeat(65),
      "?mediaCursor=" + encodeURIComponent("<script>"),
    ]) {
      const res = await POST(req(q));
      expect(res.status, q).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_input" });
    }
    expect(engineState.calls).toHaveLength(0);
  });

  it("passes validated filters through to the engine and into meta", async () => {
    const res = await POST(req("?type=blog.post&after=abc123&mediaCursor=cur-1"));
    expect(res.status).toBe(200);
    await res.text();

    expect(engineState.calls[0]).toMatchObject({
      type: "blog.post",
      after: "abc123",
      mediaCursor: "cur-1",
    });
    const meta = engineState.calls[0].meta as { filter: unknown };
    expect(meta.filter).toEqual({ type: "blog.post", after: "abc123" });
  });

  it("treats absent/empty params as null", async () => {
    await (await POST(req("?type=&after="))).text();
    expect(engineState.calls[0]).toMatchObject({ type: null, after: null });
  });
});

describe("POST /api/export — response contract", () => {
  it("streams NDJSON as a named attachment that is never cached", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/x-ndjson; charset=utf-8",
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="site-export-\d{4}-\d{2}-\d{2}\.ndjson"$/,
    );
    expect(res.body).toBeInstanceOf(ReadableStream);
  });

  it("names the file after the filtered type", async () => {
    const res = await POST(req("?type=blog.post"));
    expect(res.headers.get("Content-Disposition")).toMatch(
      /filename="site-export-blog\.post-\d{4}-\d{2}-\d{2}\.ndjson"$/,
    );
    await res.text();
  });

  it("emits meta first and end last, with the declared exclusions", async () => {
    const out = await lines(await POST(req()));
    expect(out).toHaveLength(2);

    const meta = out[0] as unknown as {
      kind: string;
      format: string;
      excludes: { what: string }[];
      types: { type: string; label?: string; fields: unknown[] }[];
      limits: { maxEntries: number };
    };
    expect(meta.kind).toBe("meta");
    expect(meta.format).toBe(EXPORT_FORMAT);
    expect(meta.excludes.map((e) => e.what)).toEqual([
      "secrets",
      "ext.* settings",
      "users",
      "content revisions",
      "media file bytes",
    ]);
    expect(meta.limits.maxEntries).toBeGreaterThan(0);
    expect(out[1].kind).toBe("end");
  });

  it("carries a content-type schema summary derived from enabled extensions", async () => {
    const out = await lines(await POST(req()));
    const meta = out[0] as unknown as {
      types: { type: string; label?: string; fields: { key: string; type: string }[] }[];
    };
    expect(meta.types).toEqual([
      {
        type: "blog.post",
        label: "Posts",
        fields: [
          { key: "title", type: "text" },
          { key: "body", type: "richtext" },
        ],
      },
    ]);
  });

  it("resolves bindings and settings before returning, not inside the stream", async () => {
    // request-scoped API 只能在 handler 回傳前呼叫;若挪進 stream 的 pull(),
    // AsyncLocalStorage 已經不在。這裡以「回傳當下就已經呼叫過」把契約釘住。
    const res = await POST(req());
    expect(bindingState.dbCalls).toBe(1);
    expect(engineState.settingsCalls).toBe(1);
    await res.text();
  });
});
