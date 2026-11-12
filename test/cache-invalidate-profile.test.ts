import { beforeEach, describe, expect, it, vi } from "vitest";

// 2.0 頁面快取(Phase 1 的發現):頁面渲染時讀過的 unstable_cache 會把它的 tag 抄到存起來的整頁上。
// 用 "max"(stale-while-revalidate)失效那些 tag,OpenNext 會把頁面當成「舊的、背景重算」,而背景重算
// 要 queue —— 這個專案沒有 queue,頁面就一直卡在舊版(每個請求都記一次 "Failed to revalidate stale page")。
// 所以剩下的 revalidateTag 一律立刻過期({ expire: 0 }),不管 tag 會不會碰到公開頁。

const calls = vi.hoisted(() => ({ revalidateTag: [] as unknown[][] }));
vi.mock("next/cache", () => ({
  revalidateTag: (...args: unknown[]) => {
    calls.revalidateTag.push(args);
  },
}));

import { revalidateContent, revalidateExt, revalidateStorageIndex } from "../src/ext/dx/cache-invalidate";

beforeEach(() => {
  calls.revalidateTag = [];
});

describe("cache-invalidate never uses stale-while-revalidate", () => {
  it("every helper expires its tag immediately", () => {
    revalidateContent("blog.post");
    revalidateExt("blog");
    revalidateStorageIndex();
    expect(calls.revalidateTag).toEqual([
      ["content:blog.post", { expire: 0 }],
      ["ext:blog", { expire: 0 }],
      ["storage:index", { expire: 0 }],
    ]);
  });
});
