import { beforeEach, describe, expect, it, vi } from "vitest";

// 2.0 頁面快取:後台刪掉一個檔,存起來的公開頁可能還指著它。重算由 deleteFile 依檔案區的 visitorFacing
// 記號決定(core 的媒體檔 true;頭像、插件的檔案區 false),這裡用真的 deleteFile、假的 R2。

const state = vi.hoisted(() => ({ deleted: [] as string[], reasons: [] as string[] }));
vi.mock("@/lib/security", () => ({
  assertSameOrigin: () => undefined,
  originErrorResponse: () => null,
}));
vi.mock("@/lib/access-api", () => ({ requireMediaAccess: async () => ({ id: "admin" }) }));
vi.mock("@/lib/auth", () => ({ authErrorResponse: () => null }));
vi.mock("@/lib/rate-limit", () => ({ hitRateLimit: async () => false }));
vi.mock("@/lib/cf", () => ({
  getStorage: () => ({ delete: async (key: string) => void state.deleted.push(key) }),
}));
vi.mock("next/cache", () => ({ revalidateTag: () => {}, revalidatePath: () => {} }));
vi.mock("@/lib/public-cache", () => ({
  publicContentChanged: (reason: string) => void state.reasons.push(reason),
}));

import { DELETE, POST } from "../src/app/api/media/delete/route";

const KEY = "core/2026/11/abcDEF123.png";

beforeEach(() => {
  state.deleted = [];
  state.reasons = [];
});

describe("admin media delete and the page cache (2.0)", () => {
  it("POST deletes the file, then remakes the stored public pages once", async () => {
    const res = await POST(
      new Request("https://cms.test/api/media/delete", { method: "POST", body: JSON.stringify({ key: KEY }) }),
    );
    expect(res.status).toBe(200);
    expect(state.deleted).toEqual([KEY]);
    expect(state.reasons).toEqual(["files:core"]);
  });

  it("DELETE does the same", async () => {
    const res = await DELETE(new Request(`https://cms.test/api/media/delete?key=${encodeURIComponent(KEY)}`, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(state.reasons).toEqual(["files:core"]);
  });

  it("a refused request deletes nothing and remakes nothing", async () => {
    const res = await POST(
      new Request("https://cms.test/api/media/delete", { method: "POST", body: JSON.stringify({ key: "../etc" }) }),
    );
    expect(res.status).toBe(400);
    expect(state.deleted).toEqual([]);
    expect(state.reasons).toEqual([]);
  });
});
