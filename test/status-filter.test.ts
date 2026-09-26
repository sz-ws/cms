import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

// 1.56.0:列表的狀態篩選可以多選 —— 網址解析(lib/status-filter.ts)、collection view 的
// state → filter(views/collection/params.ts),以及後台 CRUD 列表 API 的 ?status=。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const rt = { enabled: [], all: [], hooks: new HookBus(), byId: () => undefined, isCompatible: () => true };
  return { getExtRuntime: async () => rt };
});

import {
  coversAllStatuses,
  formatStatusList,
  parseStatusList,
  readStatusList,
  toggleStatus,
} from "../src/lib/status-filter";
import { CONTENT_STATUSES, parseState, toFilter } from "../src/ext/dx/views/collection/params";
import { buildCrudRoutes } from "../src/ext/dx/crud";
import type { DeclarativeContentType } from "../src/ext/dx/manifest";
import type { ApiCtx } from "../src/ext/types";
import type { ContentQuery } from "../src/ext/capabilities";

const ORDER = ["pending", "paid", "shipped", "done"] as const;

describe("status list in the URL", () => {
  it("reads a single value, a comma list and repeated params", () => {
    expect(parseStatusList("paid", ORDER)).toEqual(["paid"]);
    expect(parseStatusList("shipped,pending", ORDER)).toEqual(["pending", "shipped"]);
    expect(parseStatusList(["done", "paid"], ORDER)).toEqual(["paid", "done"]);
    expect(parseStatusList(["done,paid", "pending"], ORDER)).toEqual(["pending", "paid", "done"]);
  });

  it("treats a missing or empty value as all", () => {
    expect(parseStatusList(undefined, ORDER)).toEqual([]);
    expect(parseStatusList(null, ORDER)).toEqual([]);
    expect(parseStatusList("", ORDER)).toEqual([]);
    expect(parseStatusList(" , ", ORDER)).toEqual([]);
  });

  it("drops duplicates and reports unknown values", () => {
    expect(readStatusList("paid, paid ,refunded,<x>", ORDER)).toEqual({
      statuses: ["paid"],
      invalid: ["refunded", "<x>"],
    });
    expect(readStatusList("x".repeat(500), ORDER).invalid[0]).toHaveLength(64);
  });

  it("writes one URL per set of statuses", () => {
    expect(formatStatusList([])).toBeNull();
    expect(formatStatusList(["pending", "shipped"])).toBe("pending,shipped");
    expect(toggleStatus(["shipped"], "pending", ORDER)).toEqual(["pending", "shipped"]);
    expect(toggleStatus(["pending", "shipped"], "pending", ORDER)).toEqual(["shipped"]);
    const before = ["paid"] as const;
    toggleStatus(before, "done", ORDER);
    expect(before).toEqual(["paid"]);
  });

  it("knows when the selection is the same as all", () => {
    expect(coversAllStatuses([], ORDER)).toBe(true);
    expect(coversAllStatuses([...ORDER], ORDER)).toBe(true);
    expect(coversAllStatuses(["paid"], ORDER)).toBe(false);
  });
});

describe("collection view status filter", () => {
  const opts = { selectFields: [], sortableKeys: new Set<string>() };

  it("keeps the old single-status URL working", () => {
    const state = parseState({ status: "draft" }, opts);
    expect(state.status).toEqual(["draft"]);
    expect(toFilter(state)).toEqual({ status: "draft" });
  });

  it("drops the condition when both statuses are ticked", () => {
    for (const status of ["draft,published", ["published", "draft"]]) {
      const state = parseState({ status }, opts);
      expect(state.status).toEqual([...CONTENT_STATUSES]);
      expect(toFilter(state)).toEqual({});
    }
  });

  it("ignores unknown statuses", () => {
    const state = parseState({ status: "archived", page: ["2", "3"] }, opts);
    expect(state.status).toEqual([]);
    expect(state.page).toBe(2);
    expect(toFilter(state)).toEqual({});
  });
});

describe("GET /api/ext/<id>/<type> ?status=", () => {
  const CT: DeclarativeContentType = {
    name: "post",
    label: "Post",
    slugField: "title",
    fields: [{ key: "title", type: "text" }],
  };

  async function list(query: string) {
    const calls: ContentQuery[] = [];
    const provider = {
      ensureType: async () => undefined,
      query: async (_type: string, q: ContentQuery) => {
        calls.push(q);
        return { items: [], total: 0 };
      },
    };
    const ctx = { user: { id: "admin" }, services: { providers: { get: () => provider } } } as unknown as ApiCtx;
    const route = buildCrudRoutes("blog", CT).find((r) => r.method === "GET" && r.path === "post");
    if (!route) throw new Error("list route missing");
    const res = await route.handler(new Request(`https://cms.test/api/ext/blog/post${query}`), {}, ctx);
    return { res, filter: calls[0]?.filter };
  }

  it("filters by one status, old style", async () => {
    const { res, filter } = await list("?status=published");
    expect(res.status).toBe(200);
    expect(filter).toEqual({ status: "published" });
  });

  it("accepts several statuses as a comma list or repeated params", async () => {
    expect((await list("?status=draft,published")).filter).toBeUndefined();
    expect((await list("?status=draft&status=published")).filter).toBeUndefined();
    expect((await list("?status=draft&status=draft")).filter).toEqual({ status: "draft" });
    expect((await list("")).filter).toBeUndefined();
  });

  it("rejects statuses it does not know", async () => {
    const { res, filter } = await list("?status=draft,archived");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_status" });
    expect(filter).toBeUndefined();
  });
});
