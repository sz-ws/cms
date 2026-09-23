import { describe, it, expect, vi, afterEach } from "vitest";

// 付費插件協定 1 在 registry client 的四件事:
//   - 每個請求帶 X-Registry-Protocol: 1(閘道看到才列出未開通的付費插件、才回 402)
//   - 路徑變體遇到不是 404 的回應就停:402 / 403 不會被後面變體的 404 蓋掉
//   - 錯誤帶 status 與 body 的 { error, message }(message 消毒、截到 200 字)
//   - 索引的 offer 只有同時有 access 才算數;不合格的 offer 丟掉、access 留著
// 每個測試用自己的來源網址:成功的變體按來源記在模組裡。

const sourcesState = vi.hoisted(() => ({ sources: [] as string[] }));
vi.mock("@/lib/settings", () => ({
  getSetting: async () => sourcesState.sources,
  getRegistryTokenMap: async () => ({}),
}));

import {
  fetchManifest,
  fetchRegistryIndex,
  RegistryHttpError,
} from "../src/lib/registry-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Route = (url: string) => Response;

function serve(route: Route) {
  const calls: { url: string; headers: Headers }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      return route(url);
    }),
  );
  return calls;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const entry = (extra: Record<string, unknown> = {}) => ({
  id: "session-replay",
  kind: "declarative",
  name: "Session replay",
  version: "0.1.0",
  coreApi: "^1.0.0",
  ...extra,
});

const OFFER = { price: { amount: 25000, currency: "TWD", period: "year" }, note: "每站" };

describe("protocol header", () => {
  it("every registry request says which protocol it speaks", async () => {
    const source = "https://header.example.com";
    sourcesState.sources = [source];
    const calls = serve((url) =>
      url.endsWith("/registry.json") ? json(200, { extensions: [] }) : json(200, entry()),
    );
    await fetchRegistryIndex();
    await fetchManifest(source, "session-replay");
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.headers.get("X-Registry-Protocol")).toBe("1");
  });
});

describe("path variants stop at the first answer that is not 404", () => {
  it("402 from the first variant is the answer, with the sanitised message", async () => {
    const source = "https://paid.example.com";
    sourcesState.sources = [source];
    const calls = serve(() =>
      json(402, { error: "not_entitled", message: `\u001b[31m${"請聯絡提供者。".repeat(40)}\u001b[0m` }),
    );
    const error = await fetchManifest(source, "session-replay").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RegistryHttpError);
    const httpError = error as RegistryHttpError;
    expect(httpError.status).toBe(402);
    expect(httpError.code).toBe("not_entitled");
    expect(httpError.detail).toBe("請聯絡提供者。".repeat(40).slice(0, 200));
    expect(calls.map((c) => c.url)).toEqual([`${source}/extensions/session-replay/manifest.json`]);
  });

  it("403 on the index stops too, and the source error carries the status", async () => {
    const source = "https://revoked.example.com";
    sourcesState.sources = [source];
    const calls = serve(() => json(403, { error: "key_revoked" }));
    const { entries, errors } = await fetchRegistryIndex();
    expect(entries).toEqual([]);
    expect(errors).toEqual([{ source, error: "http 403", status: 403 }]);
    expect(calls).toHaveLength(1);
  });

  it("404 still moves on to the next variant, and the one that worked is tried first next time", async () => {
    const source = "https://gitlab.example.com/acme/registry";
    sourcesState.sources = [source];
    const calls = serve((url) =>
      url.startsWith(`${source}/-/raw/main/`)
        ? url.endsWith("/registry.json")
          ? json(200, { extensions: [entry()] })
          : json(200, entry())
        : new Response("not found", { status: 404 }),
    );
    const { entries } = await fetchRegistryIndex();
    expect(entries.map((e) => e.id)).toEqual(["session-replay"]);
    expect(calls.map((c) => c.url)).toEqual([`${source}/registry.json`, `${source}/-/raw/main/registry.json`]);

    await fetchManifest(source, "session-replay");
    expect(calls.at(-1)?.url).toBe(`${source}/-/raw/main/extensions/session-replay/manifest.json`);
    expect(calls).toHaveLength(3);
  });

  it("a body that is not the error shape leaves only the status", async () => {
    const source = "https://html.example.com";
    sourcesState.sources = [source];
    serve(() => new Response("<html>Payment Required</html>", { status: 402 }));
    const error = (await fetchManifest(source, "session-replay").catch((e: unknown) => e)) as RegistryHttpError;
    expect([error.status, error.code, error.detail]).toEqual([402, undefined, undefined]);
  });
});

describe("offer and access in the index", () => {
  async function parse(extensions: unknown[]) {
    const source = `https://parse-${Math.random().toString(36).slice(2)}.example.com`;
    sourcesState.sources = [source];
    serve(() => json(200, { extensions }));
    const { entries, errors } = await fetchRegistryIndex();
    expect(errors).toEqual([]);
    return entries;
  }

  it("an offer without access is ignored (a static registry cannot sell)", async () => {
    const [entryOut] = await parse([entry({ offer: OFFER })]);
    expect(entryOut.offer).toBeUndefined();
    expect(entryOut.access).toBeUndefined();
  });

  it("with access the offer is kept; a broken offer is dropped but access stays", async () => {
    const [kept, broken, bare, weird] = await parse([
      entry({ id: "kept", offer: OFFER, access: "locked" }),
      entry({ id: "broken", offer: { ...OFFER, termsUrl: "http://registry.example.com/terms" }, access: "locked" }),
      entry({ id: "bare", access: "granted" }),
      entry({ id: "weird", offer: OFFER, access: "maybe" }),
    ]);
    expect(kept).toMatchObject({ access: "locked", offer: OFFER });
    expect(broken.access).toBe("locked");
    expect(broken.offer).toBeUndefined();
    expect(bare).toMatchObject({ access: "granted" });
    expect(bare.offer).toBeUndefined();
    expect(weird.access).toBeUndefined();
    expect(weird.offer).toBeUndefined();
  });

  it("support contact: https URLs and plain addresses only", async () => {
    const [good, bad] = await parse([
      entry({ id: "good", support: { url: "https://example.com/help", email: "sales@example.com" } }),
      entry({ id: "bad", support: { url: "javascript:alert(1)", email: "a@b.co?cc=x@evil.example" } }),
    ]);
    expect([good.supportUrl, good.supportEmail]).toEqual(["https://example.com/help", "sales@example.com"]);
    expect([bad.supportUrl, bad.supportEmail]).toEqual([undefined, undefined]);
  });
});
