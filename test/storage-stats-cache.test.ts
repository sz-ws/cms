import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  listCalls: 0,
  cache: new Map<string, unknown>(),
  tags: [] as string[],
}));

vi.mock("next/cache", () => ({
  unstable_cache: <T>(
    fn: () => Promise<T>,
    key: string[],
    options: { tags?: string[] },
  ) => async () => {
    state.tags = options.tags ?? [];
    const id = JSON.stringify(key);
    if (state.cache.has(id)) return state.cache.get(id) as T;
    const value = await fn();
    state.cache.set(id, value);
    return value;
  },
}));

vi.mock("@/lib/storage", () => ({
  listFiles: async () => {
    state.listCalls++;
    return {
      files: [
        { key: "a", size: 100, contentType: "image/png" },
        { key: "b", size: 250, contentType: "image/png" },
      ],
      cursor: undefined,
    };
  },
}));

import { getStorageStats } from "../src/components/admin/dashboard/widget-data";

beforeEach(() => {
  state.listCalls = 0;
  state.cache = new Map();
  state.tags = [];
});

describe("dashboard storage snapshot", () => {
  it("reuses the tagged cache instead of listing R2 on every dashboard render", async () => {
    await expect(getStorageStats()).resolves.toEqual({
      fileCount: 2,
      totalBytes: 350,
      truncated: false,
    });
    await expect(getStorageStats()).resolves.toEqual({
      fileCount: 2,
      totalBytes: 350,
      truncated: false,
    });

    expect(state.listCalls).toBe(1);
    expect(state.tags).toEqual(["storage:index"]);
  });
});
