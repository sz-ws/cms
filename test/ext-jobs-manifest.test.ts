import { describe, it, expect } from "vitest";
import { defineExtension } from "../src/ext/types";

// spec-extension-jobs.md 測試 #8:defineExtension 對 Extension.jobs 的 zod 驗證。
// types.ts 僅型別引用 @/ext/services / @/lib/auth(import type,編譯期即消除),
// 不觸及 loader/services 執行期鏈,靜態 import 對 workers pool 安全。

const base = {
  id: "acme",
  name: "Acme",
  version: "1.0.0",
  coreApi: "^1.10.0",
};

describe("defineExtension — jobs validation (spec-extension-jobs.md)", () => {
  it("accepts a mix of periodic (`every`) and pure-handler jobs", () => {
    const ext = defineExtension({
      ...base,
      jobs: [
        { id: "sync", every: 10, run: async () => {} },
        { id: "welcome-email", run: async () => {} },
      ],
    });
    expect(ext.jobs).toHaveLength(2);
    expect(ext.jobs?.[0].every).toBe(10);
    expect(ext.jobs?.[1].every).toBeUndefined();
  });

  it("omitting jobs entirely stays valid (back-compat)", () => {
    const ext = defineExtension({ ...base });
    expect(ext.jobs).toBeUndefined();
  });

  it("throws on duplicate job ids within the same extension", () => {
    expect(() =>
      defineExtension({
        ...base,
        jobs: [
          { id: "dup", every: 10, run: async () => {} },
          { id: "dup", run: async () => {} },
        ],
      }),
    ).toThrow();
  });

  it("throws when `every` is not a positive integer", () => {
    for (const bad of [0, -1, 1.5]) {
      expect(() =>
        defineExtension({
          ...base,
          jobs: [{ id: "sync", every: bad, run: async () => {} }],
        }),
      ).toThrow();
    }
  });

  it("throws on an invalid job id (uppercase / leading digit / too long)", () => {
    for (const bad of ["Bad", "1bad", "a".repeat(32)]) {
      expect(() =>
        defineExtension({ ...base, jobs: [{ id: bad, run: async () => {} }] }),
      ).toThrow();
    }
  });

  it("throws when `run` is not a function", () => {
    expect(() =>
      defineExtension({
        ...base,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        jobs: [{ id: "sync", run: "not-a-function" as any }],
      }),
    ).toThrow();
  });

  it("accepts the shortest legal job id (single lowercase letter)", () => {
    const ext = defineExtension({
      ...base,
      jobs: [{ id: "a", run: async () => {} }],
    });
    expect(ext.jobs?.[0].id).toBe("a");
  });
});
