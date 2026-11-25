import { describe, expect, it } from "vitest";
import { CHUNK_RELOAD_KEY, CHUNK_RELOAD_WINDOW_MS, claimChunkReload, isChunkLoadError } from "@/lib/chunk-reload";

// 部署之後,瀏覽器手上的舊 HTML 會去要已經不在的 chunk(2026-11-25 一個正式站:iOS Chrome 從 Google 點進首頁,
// 拿到快取裡上一版的 HTML,頁面的 chunk 404,整頁變成 Next 預設的英文錯誤頁)。global-error.tsx 遇到這種錯
// 自動重新整理一次;這裡測「哪些錯算」與「同一個網址短時間內只重新整理一次」。

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    data,
  };
}

describe("isChunkLoadError", () => {
  it("knows webpack's ChunkLoadError by name", () => {
    const error = new Error("Loading chunk 6576 failed.\n(error: https://example.com/_next/static/chunks/6576.js)");
    error.name = "ChunkLoadError";
    expect(isChunkLoadError(error)).toBe(true);
  });

  it.each([
    "Loading chunk app/(public)/[[...slug]]/page failed.",
    "Loading CSS chunk 123 failed.",
    "Failed to load chunk /_next/static/chunks/abc.js from module 42",
    "Failed to fetch dynamically imported module: https://example.com/_next/static/chunks/x.js",
    "Importing a module script failed.",
    "error loading dynamically imported module: https://example.com/x.js",
  ])("knows the message %s", (message) => {
    expect(isChunkLoadError(new Error(message))).toBe(true);
  });

  it("leaves other errors alone", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isChunkLoadError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isChunkLoadError(Object.assign(new Error("boom"), { digest: "123" }))).toBe(false);
  });

  it("takes anything thrown, not only Errors", () => {
    expect(isChunkLoadError({ name: "ChunkLoadError", message: "" })).toBe(true);
    expect(isChunkLoadError("Loading chunk 1 failed.")).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe("claimChunkReload", () => {
  const NOW = 1_795_579_686_000;

  it("lets the first reload for a URL through and remembers it", () => {
    const storage = memoryStorage();
    expect(claimChunkReload(storage, "/", NOW)).toBe(true);
    expect(JSON.parse(storage.data.get(CHUNK_RELOAD_KEY) ?? "null")).toEqual({ path: "/", at: NOW });
  });

  it("does not reload the same URL again inside the window", () => {
    const storage = memoryStorage();
    claimChunkReload(storage, "/", NOW);
    expect(claimChunkReload(storage, "/", NOW + CHUNK_RELOAD_WINDOW_MS - 1)).toBe(false);
  });

  it("reloads the same URL again once the window has passed", () => {
    const storage = memoryStorage();
    claimChunkReload(storage, "/", NOW);
    expect(claimChunkReload(storage, "/", NOW + CHUNK_RELOAD_WINDOW_MS)).toBe(true);
  });

  it("reloads another URL right away", () => {
    const storage = memoryStorage();
    claimChunkReload(storage, "/", NOW);
    expect(claimChunkReload(storage, "/products", NOW + 1)).toBe(true);
  });

  it("does not reload when it cannot remember the reload", () => {
    expect(claimChunkReload(null, "/", NOW)).toBe(false);
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(claimChunkReload(throwing, "/", NOW)).toBe(false);
    const unreadable = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {},
    };
    expect(claimChunkReload(unreadable, "/", NOW)).toBe(false);
  });

  it("treats a damaged record as no record", () => {
    expect(claimChunkReload(memoryStorage({ [CHUNK_RELOAD_KEY]: "{not json" }), "/", NOW)).toBe(true);
    expect(claimChunkReload(memoryStorage({ [CHUNK_RELOAD_KEY]: '{"path":"/","at":"x"}' }), "/", NOW)).toBe(true);
  });

  it("treats a record from the future (a clock that went back) as no record", () => {
    const storage = memoryStorage({ [CHUNK_RELOAD_KEY]: JSON.stringify({ path: "/", at: NOW + 10_000 }) });
    expect(claimChunkReload(storage, "/", NOW)).toBe(true);
  });
});
