import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchIndex, fetchText, isNotEntitled, RegistryFetchError } from "./registry.js";

// 付費插件協定 1 在 CLI 的 registry 讀取:每個請求帶 X-Registry-Protocol、索引帶 access、
// 402 帶消毒過的 message、路徑變體遇到不是 404 的回應就停。

afterEach(() => {
  vi.unstubAllGlobals();
});

function serve(route: (url: string) => Response) {
  const calls: { url: string; headers: Headers }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      return route(url);
    }),
  );
  return calls;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SOURCE = "https://registry.example.com";

describe("registry requests", () => {
  it("say which protocol they speak", async () => {
    const calls = serve(() => json(200, { extensions: [] }));
    await fetchIndex([{ url: SOURCE, token: "t" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get("X-Registry-Protocol")).toBe("1");
    expect(calls[0].headers.get("Authorization")).toBe("token t");
  });

  it("402 carries the code and a cleaned message, and is not retried", async () => {
    const calls = serve(() =>
      json(402, { error: "not_entitled", message: `\u001b]0;pwned\u0007\u001b[2J${"請聯絡提供者。".repeat(40)}` }),
    );
    const error = await fetchText(`${SOURCE}/extensions/replay/files/index.ts`).catch((e: unknown) => e);
    expect(isNotEntitled(error)).toBe(true);
    const e = error as RegistryFetchError;
    expect([e.status, e.code]).toEqual([402, "not_entitled"]);
    expect(e.detail).toBe("請聯絡提供者。".repeat(40).slice(0, 200));
    expect(calls).toHaveLength(1);
  });

  it("the index stops at the first answer that is not 404", async () => {
    const calls = serve(() => json(403, { error: "key_revoked" }));
    const { errors } = await fetchIndex([{ url: SOURCE }]);
    expect(errors).toEqual([{ source: SOURCE, error: "HTTP 403", status: 403 }]);
    expect(calls).toHaveLength(1);
  });

  it("404 still tries the next path variant", async () => {
    const calls = serve((url) =>
      url === `${SOURCE}/-/raw/main/registry.json` ? json(200, { extensions: [] }) : new Response("nope", { status: 404 }),
    );
    const { errors } = await fetchIndex([{ url: SOURCE }]);
    expect(errors).toEqual([]);
    expect(calls.map((c) => c.url)).toEqual([`${SOURCE}/registry.json`, `${SOURCE}/-/raw/main/registry.json`]);
  });
});

describe("index entries", () => {
  it("carry access, and printable fields come back clean", async () => {
    serve(() =>
      json(200, {
        extensions: [
          { id: "replay", kind: "code", name: "\u001b[31mReplay\u001b[0m", version: "1.0.0", coreApi: "^1.0.0", access: "locked" },
          { id: "free", kind: "code", name: "Free", version: "1.0.0", coreApi: "^1.0.0", access: "whatever" },
        ],
      }),
    );
    const { entries } = await fetchIndex([{ url: SOURCE }]);
    expect(entries.map((e) => [e.id, e.name, e.access])).toEqual([
      ["replay", "Replay", "locked"],
      ["free", "Free", undefined],
    ]);
  });
});
