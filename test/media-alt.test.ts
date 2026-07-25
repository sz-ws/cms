import { describe, it, expect, beforeEach, vi } from "vitest";

// lib/storage.ts 的 alt(R2 customMetadata)行為測試。
// R2 不在 vitest.config 的 miniflare bindings 內,故 mock @/lib/cf 的 getStorage
// (同 test/account-avatar.test.ts 的手法),用一個假 bucket 驗證我們自己的規則:
// list 有帶 customMetadata、put 保留 body/httpMetadata/其他 metadata、
// 空字串清除 alt、etag 不符 → conflict(不會拿舊 body 蓋掉新上傳)。

interface FakeObject {
  body: ArrayBuffer;
  etag: string;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

const bucketState = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  listOptions: null as unknown,
  /** put 前把物件換掉(模擬並發覆蓋),用來測 onlyIf。 */
  mutateBeforePut: null as null | (() => void),
}));

function encode(text: string): ArrayBuffer {
  const src = new TextEncoder().encode(text);
  const out = new ArrayBuffer(src.length);
  new Uint8Array(out).set(src);
  return out;
}

function decode(buf: ArrayBuffer): string {
  return new TextDecoder().decode(new Uint8Array(buf));
}

const store = () => bucketState.store as Map<string, FakeObject>;

const fakeBucket = {
  async get(key: string) {
    const o = store().get(key);
    if (!o) return null;
    return {
      key,
      size: o.body.byteLength,
      etag: o.etag,
      httpMetadata: o.httpMetadata,
      customMetadata: o.customMetadata,
      arrayBuffer: async () => o.body,
    };
  },
  async put(
    key: string,
    value: ArrayBuffer,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      onlyIf?: { etagMatches?: string };
    },
  ) {
    bucketState.mutateBeforePut?.();
    if (options?.onlyIf?.etagMatches !== undefined) {
      const cur = store().get(key);
      if (!cur || cur.etag !== options.onlyIf.etagMatches) return null;
    }
    const next: FakeObject = {
      body: value,
      etag: `etag-${store().size}-${Math.random().toString(36).slice(2)}`,
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
    };
    store().set(key, next);
    return { key, size: next.body.byteLength, etag: next.etag };
  },
  async list(options: unknown) {
    bucketState.listOptions = options;
    const objects = Array.from(store().entries()).map(([key, o]) => ({
      key,
      size: o.body.byteLength,
      httpMetadata: o.httpMetadata,
      customMetadata: o.customMetadata,
    }));
    return { objects, truncated: false as const };
  },
  async delete() {},
};

vi.mock("@/lib/cf", () => ({
  getStorage: () => fakeBucket,
}));

// putFile 會動態 import ext runtime 觸發 storage:uploaded hook;測試不需要真的載入。
vi.mock("@/ext/loader", () => ({
  getExtRuntime: async () => ({ hooks: { doAction: async () => {} } }),
}));

import {
  listFiles,
  putFile,
  updateFileAlt,
  normalizeAlt,
  MAX_ALT_LENGTH,
} from "../src/lib/storage";

const KEY = "core/2026/07/abc123.png";

function seed(custom?: Record<string, string>) {
  store().set(KEY, {
    body: encode("PNGDATA"),
    etag: "etag-1",
    httpMetadata: { contentType: "image/png" },
    customMetadata: custom,
  });
}

beforeEach(() => {
  store().clear();
  bucketState.listOptions = null;
  bucketState.mutateBeforePut = null;
});

describe("normalizeAlt", () => {
  it("trims and collapses whitespace (alt is single-line)", () => {
    expect(normalizeAlt("  a  red \n bike \t ")).toBe("a red bike");
  });

  it("truncates at MAX_ALT_LENGTH", () => {
    expect(normalizeAlt("x".repeat(MAX_ALT_LENGTH + 50)).length).toBe(
      MAX_ALT_LENGTH,
    );
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeAlt("   \n ")).toBe("");
  });
});

describe("listFiles", () => {
  it("asks R2 for customMetadata and surfaces alt", async () => {
    seed({ alt: "a red bike" });
    const { files } = await listFiles("");
    expect(
      (bucketState.listOptions as { include: string[] }).include,
    ).toEqual(["httpMetadata", "customMetadata"]);
    expect(files[0].alt).toBe("a red bike");
    expect(files[0].contentType).toBe("image/png");
  });

  it("omits alt when the object has none", async () => {
    seed();
    const { files } = await listFiles("");
    expect(files[0].alt).toBeUndefined();
  });
});

describe("putFile", () => {
  it("writes normalized alt into customMetadata", async () => {
    const file = await putFile("core", "a.png", encode("X"), "image/png", "  hello  world ");
    expect(file.alt).toBe("hello world");
    expect(store().get(file.key)?.customMetadata).toEqual({ alt: "hello world" });
  });

  it("writes no customMetadata when alt is absent", async () => {
    const file = await putFile("core", "a.png", encode("X"), "image/png");
    expect(file.alt).toBeUndefined();
    expect(store().get(file.key)?.customMetadata).toBeUndefined();
  });
});

describe("updateFileAlt", () => {
  it("sets alt while preserving body, contentType and other metadata", async () => {
    seed({ caption: "keep me" });
    const res = await updateFileAlt(KEY, "  a red  bike ");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.file.alt).toBe("a red bike");
    expect(res.file.contentType).toBe("image/png");

    const stored = store().get(KEY)!;
    // 關鍵:R2 的 put 會整個覆蓋 object —— body 必須原封不動地回去。
    expect(decode(stored.body)).toBe("PNGDATA");
    expect(stored.httpMetadata?.contentType).toBe("image/png");
    expect(stored.customMetadata).toEqual({ caption: "keep me", alt: "a red bike" });
  });

  it("clears alt on empty string but keeps the file and its other metadata", async () => {
    seed({ alt: "old", caption: "keep me" });
    const res = await updateFileAlt(KEY, "   ");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.file.alt).toBeUndefined();
    const stored = store().get(KEY)!;
    expect(stored.customMetadata).toEqual({ caption: "keep me" });
    expect(decode(stored.body)).toBe("PNGDATA");
  });

  it("truncates over-long alt instead of writing it raw", async () => {
    seed();
    const res = await updateFileAlt(KEY, "y".repeat(MAX_ALT_LENGTH + 10));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.file.alt?.length).toBe(MAX_ALT_LENGTH);
  });

  it("returns not_found for a missing key", async () => {
    const res = await updateFileAlt("core/2026/07/nope.png", "x");
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns conflict (and does not clobber) when the object changed mid-flight", async () => {
    seed();
    bucketState.mutateBeforePut = () => {
      store().set(KEY, {
        body: encode("NEWUPLOAD"),
        etag: "etag-2",
        httpMetadata: { contentType: "image/png" },
      });
    };
    const res = await updateFileAlt(KEY, "a red bike");
    expect(res).toEqual({ ok: false, reason: "conflict" });
    // 舊 body 沒有蓋掉新上傳的內容。
    expect(decode(store().get(KEY)!.body)).toBe("NEWUPLOAD");
  });
});
