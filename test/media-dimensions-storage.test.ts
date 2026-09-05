import { describe, it, expect, beforeEach, vi } from "vitest";

// lib/storage.ts 的尺寸(R2 customMetadata "w"/"h")行為。
// R2 不在 vitest.config 的 miniflare bindings 內,故 mock @/lib/cf 的 getStorage
// (同 test/media-alt.test.ts 的手法),用假 bucket 驗我們自己的規則:
// 上傳時嗅一次寫進 metadata、list/head 讀得回來、非圖片與嗅不出的檔不寫、
// 以及**既有檔案**(沒有 w/h 的舊物件)照樣讀得出來不會炸。

interface FakeObject {
  body: ArrayBuffer;
  etag: string;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

const bucketState = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  lastPutOptions: null as unknown,
}));

const store = () => bucketState.store as Map<string, FakeObject>;

const fakeBucket = {
  async put(
    key: string,
    value: ArrayBuffer | Blob,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ) {
    bucketState.lastPutOptions = options ?? null;
    const body =
      value instanceof Blob ? await value.arrayBuffer() : (value as ArrayBuffer);
    const next: FakeObject = {
      body,
      etag: `etag-${store().size}`,
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
    };
    store().set(key, next);
    return { key, size: body.byteLength, etag: next.etag };
  },
  async head(key: string) {
    const o = store().get(key);
    if (!o) return null;
    return {
      key,
      size: o.body.byteLength,
      etag: o.etag,
      httpMetadata: o.httpMetadata,
      customMetadata: o.customMetadata,
    };
  },
  async list() {
    const objects = [...store().entries()].map(([key, o]) => ({
      key,
      size: o.body.byteLength,
      httpMetadata: o.httpMetadata,
      customMetadata: o.customMetadata,
    }));
    return { objects, truncated: false, cursor: undefined };
  },
};

vi.mock("@/lib/cf", () => ({ getStorage: () => fakeBucket }));
// putFile 會 doAction("storage:uploaded");extension runtime 與本測無關,打樁掉。
vi.mock("@/ext/loader", () => ({
  getExtRuntime: async () => ({ hooks: { doAction: async () => {} } }),
}));
// put/delete 現在會失效 dashboard storage snapshot；此檔只驗 R2 metadata，
// 沒有 Next request cache scope，故把失效器打樁掉避免無關的 stderr。
vi.mock("@/ext/dx/cache-invalidate", () => ({
  revalidateStorageIndex: () => {},
}));

import { putFile, headFile, listFiles } from "@/lib/storage";

function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function chars(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

/** 最小合法 PNG 檔頭 + 一大坨 padding(模擬真實檔案的體積)。 */
function pngBlob(w: number, h: number, padding = 4096): Blob {
  const header = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13),
    ...chars("IHDR"),
    ...be32(w),
    ...be32(h),
    8, 6, 0, 0, 0,
  ]);
  return new Blob([header, new Uint8Array(padding)], { type: "image/png" });
}

beforeEach(() => {
  bucketState.store = new Map();
  bucketState.lastPutOptions = null;
});

describe("putFile records intrinsic dimensions", () => {
  it("sniffs a PNG and writes w/h into customMetadata", async () => {
    const file = await putFile("core", "photo.png", pngBlob(1920, 1080), "image/png");
    expect(file.width).toBe(1920);
    expect(file.height).toBe(1080);
    const opts = bucketState.lastPutOptions as {
      customMetadata?: Record<string, string>;
    };
    expect(opts.customMetadata).toMatchObject({ w: "1920", h: "1080" });
  });

  it("only reads the header, not the whole file", async () => {
    // 8MB 的假檔:嗅探切前 64KB,不該把整份讀進來(這裡驗行為結果 —— 尺寸仍正確)。
    const file = await putFile(
      "core",
      "big.png",
      pngBlob(4032, 3024, 8 * 1024 * 1024),
      "image/png",
    );
    expect(file).toMatchObject({ width: 4032, height: 3024 });
  });

  it("stores alt and dimensions side by side", async () => {
    const file = await putFile(
      "core",
      "photo.png",
      pngBlob(800, 600),
      "image/png",
      "A cat",
    );
    expect(file).toMatchObject({ alt: "A cat", width: 800, height: 600 });
  });

  it("writes no dimension metadata for a non-image", async () => {
    const file = await putFile(
      "core",
      "doc.pdf",
      new Blob(["%PDF-1.7"], { type: "application/pdf" }),
      "application/pdf",
    );
    expect(file.width).toBeUndefined();
    expect(file.height).toBeUndefined();
    const opts = bucketState.lastPutOptions as { customMetadata?: unknown };
    expect(opts.customMetadata).toBeUndefined();
  });

  it("still uploads when the format can't be sniffed", async () => {
    // image/* 但內容認不出來 —— 上傳必須成功,只是沒有尺寸。
    const file = await putFile(
      "core",
      "weird.tiff",
      new Blob([new Uint8Array(64).fill(0x11)], { type: "image/tiff" }),
      "image/tiff",
    );
    expect(file.key).toContain("core/");
    expect(file.width).toBeUndefined();
  });

  it("does not sniff a ReadableStream body (documented no-op, upload still works)", async () => {
    const stream = new Response(pngBlob(100, 50)).body!;
    const file = await putFile("core", "streamed.png", stream, "image/png");
    expect(file.key).toContain("core/");
    expect(file.width).toBeUndefined();
  });
});

describe("reading dimensions back", () => {
  it("headFile returns them", async () => {
    const { key } = await putFile("core", "a.png", pngBlob(640, 480), "image/png");
    await expect(headFile(key)).resolves.toMatchObject({
      width: 640,
      height: 480,
    });
  });

  it("headFile returns null for a missing key", async () => {
    await expect(headFile("core/2026/07/nope.png")).resolves.toBeNull();
  });

  it("listFiles returns them without a second lookup", async () => {
    await putFile("core", "a.png", pngBlob(320, 240), "image/png");
    const { files } = await listFiles("");
    expect(files[0]).toMatchObject({ width: 320, height: 240 });
  });

  it("tolerates pre-existing objects that have no w/h at all", async () => {
    // 這個功能上線前上傳的檔:metadata 裡沒有 w/h,讀取端不能炸,只是沒有尺寸。
    store().set("core/2026/01/legacy.png", {
      body: new ArrayBuffer(10),
      etag: "legacy",
      httpMetadata: { contentType: "image/png" },
      customMetadata: { alt: "old" },
    });
    const head = await headFile("core/2026/01/legacy.png");
    expect(head).toMatchObject({ alt: "old" });
    expect(head?.width).toBeUndefined();
    const { files } = await listFiles("");
    expect(files[0].width).toBeUndefined();
  });

  it("ignores corrupt dimension metadata", async () => {
    store().set("core/2026/01/bad.png", {
      body: new ArrayBuffer(10),
      etag: "bad",
      httpMetadata: { contentType: "image/png" },
      customMetadata: { w: "not-a-number", h: "0" },
    });
    const head = await headFile("core/2026/01/bad.png");
    expect(head?.width).toBeUndefined();
    expect(head?.height).toBeUndefined();
  });
});
