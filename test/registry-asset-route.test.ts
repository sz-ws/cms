import { describe, it, expect, beforeEach, vi } from "vitest";

// GET /api/registry/asset 的快取行為測試(Cache-Control / ETag / If-None-Match)。
// 純 mock 隔離所有 I/O(auth/rate-limit/registry-client)——這支 route 不碰 D1,
// 聚焦在「快取 header 對不對」而非 SSRF/白名單邏輯(那些已由 registry-asset.test.ts
// 的純函式測試 + route 本身既有邏輯覆蓋,這裡不重複)。

const ADMIN = { id: "u-admin", email: "admin@test.com", name: "Admin", role: "admin" as const };

vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAuth: async () => ADMIN,
  };
});

const rateLimitState = vi.hoisted(() => ({ blocked: false }));
vi.mock("@/lib/rate-limit", () => ({
  hitRateLimit: async () => rateLimitState.blocked,
}));

const assetState = vi.hoisted(() => ({
  bytes: new Uint8Array([1, 2, 3]),
  etag: null as string | null,
  shouldThrow: false,
  knownSource: true,
  fetchCalls: 0,
}));
vi.mock("@/lib/registry-client", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/registry-client")>();
  return {
    ...actual,
    assertKnownRegistrySource: async (source: string) => {
      if (!assetState.knownSource) {
        throw new actual.UnknownRegistrySource(source);
      }
    },
    fetchExtensionAssetBytes: async () => {
      assetState.fetchCalls += 1;
      if (assetState.shouldThrow) throw new Error("upstream 502");
      return {
        bytes: assetState.bytes,
        contentType: "image/png",
        etag: assetState.etag,
      };
    },
  };
});

import { GET } from "../src/app/api/registry/asset/route";

const ORIGIN = "https://cms.test";

function req(qs: string, headers?: Record<string, string>): Request {
  return new Request(`${ORIGIN}/api/registry/asset?${qs}`, { headers });
}

const VALID_QS = "source=https://example.test&id=cron&file=icon.png";

beforeEach(() => {
  rateLimitState.blocked = false;
  assetState.bytes = new Uint8Array([1, 2, 3]);
  assetState.etag = null;
  assetState.shouldThrow = false;
  assetState.knownSource = true;
  assetState.fetchCalls = 0;
});

describe("GET /api/registry/asset — success caching", () => {
  it("sets a public, revalidatable Cache-Control on a 200 response", async () => {
    const res = await GET(req(VALID_QS));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=3600, stale-while-revalidate=86400",
    );
  });

  it("passes through the upstream ETag when present", async () => {
    assetState.etag = '"abc123"';
    const res = await GET(req(VALID_QS));
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"abc123"');
  });

  it("omits ETag when upstream did not send one", async () => {
    assetState.etag = null;
    const res = await GET(req(VALID_QS));
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBeNull();
  });

  it("returns 304 with no body when If-None-Match matches the upstream ETag", async () => {
    assetState.etag = '"abc123"';
    const res = await GET(req(VALID_QS, { "if-none-match": '"abc123"' }));
    expect(res.status).toBe(304);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=3600, stale-while-revalidate=86400",
    );
    expect(res.headers.get("ETag")).toBe('"abc123"');
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(0);
  });

  it("returns 200 with body when If-None-Match does not match", async () => {
    assetState.etag = '"abc123"';
    const res = await GET(req(VALID_QS, { "if-none-match": '"stale"' }));
    expect(res.status).toBe(200);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect([...buf]).toEqual([1, 2, 3]);
  });

  it("still fetches upstream (no conditional forwarding) even with a matching If-None-Match", async () => {
    // 設計選擇:即使 client 帶對的 If-None-Match,route 仍走完整的
    // fetchExtensionAssetBytes(只是把結果換成 304 回給 client)——不做「先問
    // upstream 是否 304 再決定要不要下載」的 conditional forwarding(見 route.ts
    // 檔案頂端註解)。fetchCalls 計數器直接證明這次呼叫確實打了一次 upstream。
    assetState.etag = '"abc123"';
    await GET(req(VALID_QS, { "if-none-match": '"abc123"' }));
    expect(assetState.fetchCalls).toBe(1);
  });
});

describe("GET /api/registry/asset — error responses stay uncached", () => {
  it("400 invalid_input (missing params)", async () => {
    const res = await GET(req("source=https://example.test&id=cron"));
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("400 invalid_id", async () => {
    const res = await GET(
      req("source=https://example.test&id=Bad_ID&file=icon.png"),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("400 invalid_file", async () => {
    const res = await GET(
      req("source=https://example.test&id=cron&file=payload.exe"),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("400 unknown_source", async () => {
    assetState.knownSource = false;
    const res = await GET(req(VALID_QS));
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("429 rate_limited", async () => {
    rateLimitState.blocked = true;
    const res = await GET(req(VALID_QS));
    expect(res.status).toBe(429);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("502 asset_fetch_failed", async () => {
    assetState.shouldThrow = true;
    const res = await GET(req(VALID_QS));
    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
