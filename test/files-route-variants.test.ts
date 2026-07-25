import { describe, it, expect, beforeEach, vi } from "vitest";

// GET /api/files/<key> 的變體與**降級**行為。
//
// 降級是這條路徑的重點:Cloudflare Images 是可選的付費功能,scaffold 的部署者很
// 可能沒開。所以這裡最在意的不是「轉得對不對」(那是 Cloudflare 的責任),而是
// 「轉不動的時候有沒有照樣把原圖送出去」—— 任何一種轉換失敗都不可以變成 404/500。

const storageState = vi.hoisted(() => ({
  object: null as unknown,
}));
vi.mock("@/lib/storage", () => ({
  getFile: async () => storageState.object,
}));

const cfState = vi.hoisted(() => ({
  images: undefined as unknown,
}));
vi.mock("@/lib/cf", () => ({
  getImages: () => cfState.images,
}));

import { GET } from "../src/app/api/files/[[...key]]/route";

const KEY = "core/2026/07/abc123.jpg";
const ORIGINAL = new TextEncoder().encode("ORIGINAL-BYTES").buffer;
const TRANSFORMED = new TextEncoder().encode("SMALLER").buffer;

/** 最小的 R2ObjectBody 替身:route 只用到 body / arrayBuffer / httpMetadata / httpEtag。 */
function r2Object(contentType: string, bytes: ArrayBuffer = ORIGINAL) {
  return {
    httpMetadata: { contentType },
    httpEtag: '"src-etag"',
    get body() {
      return new Response(bytes.slice(0)).body;
    },
    arrayBuffer: async () => bytes.slice(0),
  };
}

function call(key: string, query = ""): Promise<Response> {
  const url = `https://cms.test/api/files/${key}${query}`;
  return GET(new Request(url), { params: Promise.resolve({ key: key.split("/") }) });
}

/** 會成功的 IMAGES binding 替身,記下收到的 transform / output 參數。 */
function workingImages() {
  const calls: { transform: unknown[]; output: unknown } = {
    transform: [],
    output: null,
  };
  const handle = {
    transform(t: unknown) {
      calls.transform.push(t);
      return handle;
    },
    async output(o: unknown) {
      calls.output = o;
      return { response: () => new Response(TRANSFORMED.slice(0)) };
    },
  };
  return { binding: { input: () => handle }, calls };
}

beforeEach(() => {
  storageState.object = r2Object("image/jpeg");
  cfState.images = undefined;
});

describe("no variant requested", () => {
  it("serves the original untouched", async () => {
    const res = await call(KEY);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("X-Image-Transform")).toBe("none");
    expect(res.headers.get("ETag")).toBe('"src-etag"');
    expect(await res.text()).toBe("ORIGINAL-BYTES");
  });

  it("keeps every security header", async () => {
    const res = await call(KEY);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("still 404s a missing object", async () => {
    storageState.object = null;
    expect((await call(KEY)).status).toBe(404);
  });

  it("still 400s a traversal attempt", async () => {
    const res = await GET(new Request("https://cms.test/api/files/a/../b"), {
      params: Promise.resolve({ key: ["a", "..", "b"] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("degradation — transforms unavailable", () => {
  it("serves the original when the IMAGES binding is absent", async () => {
    // 最常見的情境:帳號沒開 Cloudflare Images,binding 執行期就是 undefined。
    cfState.images = undefined;
    const res = await call(KEY, "?w=320");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ORIGINAL-BYTES");
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    // binding 不在 → 連 body 都沒碰過,所以標記是 "none" 而不是 "unavailable"。
    expect(res.headers.get("X-Image-Transform")).toBe("none");
  });

  it("serves the original when input() throws", async () => {
    cfState.images = {
      input: () => {
        throw new Error("IMAGES not entitled for this account");
      },
    };
    const res = await call(KEY, "?w=320");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ORIGINAL-BYTES");
    expect(res.headers.get("X-Image-Transform")).toBe("unavailable");
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
  });

  it("serves the original when output() rejects", async () => {
    const handle = {
      transform() {
        return handle;
      },
      output: async () => {
        throw new Error("ERROR 9412: input is not an image");
      },
    };
    cfState.images = { input: () => handle };
    const res = await call(KEY, "?w=640");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ORIGINAL-BYTES");
    expect(res.headers.get("X-Image-Transform")).toBe("unavailable");
  });

  it("keeps the security headers on the degraded response", async () => {
    cfState.images = {
      input: () => {
        throw new Error("nope");
      },
    };
    const res = await call(KEY, "?w=320");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
  });
});

describe("transform applied", () => {
  it("returns the converted bytes with the requested format", async () => {
    const { binding, calls } = workingImages();
    cfState.images = binding;
    const res = await call(KEY, "?w=640&f=avif");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("SMALLER");
    expect(res.headers.get("Content-Type")).toBe("image/avif");
    expect(res.headers.get("X-Image-Transform")).toBe("applied");
    expect(calls.transform).toEqual([{ width: 640, fit: "scale-down" }]);
    expect(calls.output).toEqual({ format: "image/avif" });
  });

  it("defaults to webp when only a width is given", async () => {
    const { binding, calls } = workingImages();
    cfState.images = binding;
    const res = await call(KEY, "?w=320");
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(calls.output).toEqual({ format: "image/webp" });
  });

  it("snaps an arbitrary width into the closed tier list", async () => {
    const { binding, calls } = workingImages();
    cfState.images = binding;
    await call(KEY, "?w=333");
    expect(calls.transform).toEqual([{ width: 640, fit: "scale-down" }]);
  });

  it("gives the variant its own ETag", async () => {
    const { binding } = workingImages();
    cfState.images = binding;
    const a = await call(KEY, "?w=320");
    const b = await call(KEY, "?w=1280");
    expect(a.headers.get("ETag")).not.toBe(b.headers.get("ETag"));
    expect(a.headers.get("ETag")).not.toBe('"src-etag"');
  });

  it("converts without resizing when only a format is given", async () => {
    const { binding, calls } = workingImages();
    cfState.images = binding;
    await call(KEY, "?f=webp");
    expect(calls.transform).toEqual([]); // 沒有 width → 不呼叫 transform()
    expect(calls.output).toEqual({ format: "image/webp" });
  });
});

describe("non-transformable sources are passed through", () => {
  it("does not touch a GIF even with ?w=", async () => {
    const { binding, calls } = workingImages();
    cfState.images = binding;
    storageState.object = r2Object("image/gif");
    const res = await call("core/2026/07/a.gif", "?w=320");
    expect(res.headers.get("Content-Type")).toBe("image/gif");
    expect(res.headers.get("X-Image-Transform")).toBe("none");
    expect(calls.output).toBeNull();
  });

  it("does not touch a PDF, and still forces download", async () => {
    const { binding } = workingImages();
    cfState.images = binding;
    storageState.object = r2Object("application/pdf");
    const res = await call("core/2026/07/a.pdf", "?w=320");
    // pdf 在白名單內但不可轉換 → 原樣送,不帶 attachment。
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("X-Image-Transform")).toBe("none");
  });

  it("forces download for a non-whitelisted type regardless of ?w=", async () => {
    const { binding } = workingImages();
    cfState.images = binding;
    storageState.object = r2Object("image/svg+xml");
    const res = await call("core/2026/07/a.svg", "?w=320");
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toBe("attachment");
    expect(res.headers.get("X-Image-Transform")).toBe("none");
  });
});
