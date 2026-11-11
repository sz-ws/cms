import { describe, it, expect, beforeEach, vi } from "vitest";

// 2.0 頁面快取:publicContentChanged(reason) 是「訪客看得到的東西變了」唯一的出口。
// 它只做一件事 —— revalidatePath("/", "layout"),讓每一個存起來的公開頁在下一次造訪時
// 重算 —— 而且永遠不 throw:失敗要記錄、要回報,但寫入本身不能因此失敗。

const calls = vi.hoisted(() => ({
  revalidatePath: [] as unknown[][],
  reported: [] as { error: unknown; tags: Record<string, string> }[],
  fail: null as Error | null,
}));

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => {
    if (calls.fail) throw calls.fail;
    calls.revalidatePath.push(args);
  },
}));

vi.mock("@/lib/observe/report", () => ({
  reportError: async (error: unknown, tags: Record<string, string>) => {
    calls.reported.push({ error, tags });
  },
}));

import { publicContentChanged } from "../src/lib/public-cache";

beforeEach(() => {
  calls.revalidatePath = [];
  calls.reported = [];
  calls.fail = null;
});

describe("publicContentChanged", () => {
  it("讓整個公開站失效:revalidatePath('/', 'layout'),不帶 profile(立刻過期,不需要 queue)", () => {
    publicContentChanged("content:blog.post");
    expect(calls.revalidatePath).toEqual([["/", "layout"]]);
  });

  it("revalidatePath 丟例外(不在 Next 的請求裡)→ 不 throw,記錄並回報,帶著 reason", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    calls.fail = new Error("Invariant: static generation store missing in revalidatePath /");
    expect(() => publicContentChanged("content:blog.post")).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("content:blog.post"),
      calls.fail,
    );
    expect(calls.reported).toEqual([
      { error: calls.fail, tags: { kind: "public-cache", reason: "content:blog.post" } },
    ]);
    error.mockRestore();
  });
});
