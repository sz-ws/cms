import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// 2.0 頁面快取的 tag 快取(open-next.config.ts 的 tagCache):OpenNext 的 D1NextModeTagCache,行為不變,
// 只在 D1 讀寫失敗時多記一行好查的 [page-cache] log。寫失敗照樣丟出去(OpenNext 的 revalidateTag
// 接住並記錄);讀失敗照樣當作沒有失效(fail open)。

import { pageCacheTagCache, TAG_READ_FAILED, TAG_WRITE_FAILED } from "../src/lib/page-cache-tags";

const d1 = () => (env as { DB: D1Database }).DB;
const CONTEXT = Symbol.for("__cloudflare-context__");
const g = globalThis as unknown as Record<symbol | string, unknown>;

function bind(db: D1Database): void {
  g[CONTEXT] = { env: { NEXT_TAG_CACHE_D1: db }, ctx: { waitUntil() {} }, cf: {} };
}
const broken = {
  prepare: () => ({
    bind: () => ({ raw: async () => { throw new Error("D1 read down"); } }),
  }),
  batch: async () => { throw new Error("D1 write down"); },
} as unknown as D1Database;

beforeAll(async () => {
  g.openNextConfig = {};
  await d1().exec("CREATE TABLE IF NOT EXISTS revalidations (tag TEXT NOT NULL, revalidatedAt INTEGER NOT NULL, stale INTEGER, expire INTEGER, UNIQUE(tag) ON CONFLICT REPLACE);");
});
beforeEach(async () => {
  await d1().exec("DELETE FROM revalidations;");
});
afterEach(() => {
  delete g[CONTEXT];
  vi.restoreAllMocks();
});

describe("page cache tag cache", () => {
  it("is OpenNext's D1 tag cache (same name, so deploy still creates the revalidations table)", () => {
    expect(pageCacheTagCache.name).toBe("d1-next-mode-tag-cache");
    expect(pageCacheTagCache.mode).toBe("nextMode");
  });

  it("records and reads invalidations through the wrapped binding", async () => {
    bind(d1());
    const before = Date.now() - 1000;
    await pageCacheTagCache.writeTags([{ tag: "_N_T_/layout", expire: Date.now() }]);
    expect(await pageCacheTagCache.hasBeenRevalidated(["_N_T_/layout"], before)).toBe(true);
    expect(await pageCacheTagCache.hasBeenRevalidated(["_N_T_/other"], before)).toBe(false);
  });

  it("logs a failed write with the [page-cache] prefix and still throws", async () => {
    bind(broken);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(pageCacheTagCache.writeTags(["_N_T_/layout"])).rejects.toThrow("D1 write down");
    expect(log).toHaveBeenCalledWith(TAG_WRITE_FAILED, expect.any(Error));
  });

  it("logs a failed read and keeps OpenNext's fail-open answer", async () => {
    bind(broken);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await pageCacheTagCache.hasBeenRevalidated(["_N_T_/layout"], 1)).toBe(false);
    expect(log).toHaveBeenCalledWith(TAG_READ_FAILED, expect.any(Error));
  });
});
