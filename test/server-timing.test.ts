import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { serverTimingHeader, startTiming, timedEnv, withServerTiming } from "../src/lib/server-timing";

// src/lib/server-timing.ts:包過的 binding 要跟原本的用法完全一樣(Proxy 包的是 runtime 的原生
// 物件,方法沒綁回原物件會 Illegal invocation;batch 要拿到原生 statement),同時把次數記下來。
// 用 miniflare 真的 D1 / R2,不用假物件 —— 會壞的正是原生物件那一層。

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

describe("server timing", () => {
  it("counts D1 queries through prepare/bind/first/all/run/raw and batch, results unchanged", async () => {
    const timing = startTiming();
    const wrapped = timedEnv(env as unknown as CloudflareEnv, timing);
    const db = wrapped.DB;
    await db.exec("CREATE TABLE IF NOT EXISTS timing_probe (id INTEGER PRIMARY KEY, name TEXT)");
    await db.prepare("DELETE FROM timing_probe").run();
    await db.batch([
      db.prepare("INSERT INTO timing_probe (id, name) VALUES (?, ?)").bind(1, "a"),
      db.prepare("INSERT INTO timing_probe (id, name) VALUES (?, ?)").bind(2, "b"),
    ]);
    const first = await db.prepare("SELECT name FROM timing_probe WHERE id = ?").bind(2).first<{ name: string }>();
    const all = await db.prepare("SELECT id FROM timing_probe ORDER BY id").all<{ id: number }>();
    const raw = await db.prepare("SELECT id FROM timing_probe ORDER BY id").raw();
    expect(first?.name).toBe("b");
    expect(all.results.map((row) => row.id)).toEqual([1, 2]);
    expect(raw).toEqual([[1], [2]]);
    // exec、run、batch、first、all、raw 各一次。
    expect(timing.d1.n).toBe(6);
    expect(timing.tag.n).toBe(0);
  });

  it("counts R2 calls and keeps the rest of env as is", async () => {
    // 測試環境沒有 R2 binding。用 private field 的假 bucket:方法沒綁回原物件就會 TypeError,
    // 跟原生物件一樣挑剔。
    class FakeBucket {
      #store = new Map<string, string>();
      async put(key: string, value: string) {
        this.#store.set(key, value);
      }
      async get(key: string) {
        const value = this.#store.get(key);
        return value === undefined ? null : { text: async () => value };
      }
      async delete(key: string) {
        this.#store.delete(key);
      }
    }
    const base = { ...(env as unknown as CloudflareEnv), STORAGE: new FakeBucket() as unknown as R2Bucket };
    const timing = startTiming();
    const wrapped = timedEnv(base, timing);
    await wrapped.STORAGE.put("timing-probe.txt", "hi");
    const object = await wrapped.STORAGE.get("timing-probe.txt");
    expect(await object?.text()).toBe("hi");
    await wrapped.STORAGE.delete("timing-probe.txt");
    expect(timing.r2.n).toBe(3);
    expect(timing.cache.n).toBe(0);
    expect(wrapped.CMS_SITE_SLUG).toBe(base.CMS_SITE_SLUG);
  });

  it("counts KV calls when CMS_KV is bound, and leaves it out when it isn't", async () => {
    class FakeKv {
      #store = new Map<string, string>();
      async get(key: string) {
        return this.#store.get(key) ?? null;
      }
      async put(key: string, value: string) {
        this.#store.set(key, value);
      }
    }
    const timing = startTiming();
    const bound = timedEnv({ ...(env as unknown as CloudflareEnv), CMS_KV: new FakeKv() } as unknown as CloudflareEnv, timing);
    const kv = (bound as unknown as { CMS_KV: KVNamespace }).CMS_KV;
    await kv.put("k", "v");
    expect(await kv.get("k")).toBe("v");
    expect(timing.kv.n).toBe(2);
    const unbound = timedEnv(env as unknown as CloudflareEnv, startTiming());
    expect((unbound as unknown as { CMS_KV?: KVNamespace }).CMS_KV).toBeUndefined();
  });

  it("writes the Server-Timing header and marks only the first request in an isolate as cold", () => {
    const later = startTiming();
    expect(later.cold).toBe(false);
    later.d1 = { n: 2, ms: 12.34 };
    const header = serverTimingHeader(later);
    expect(header).toMatch(/^total;dur=[\d.]+, d1;dur=12\.3;desc="2 queries", tag;dur=0\.0;desc="0 queries"/);
    expect(header).not.toContain("cold");
  });

  it("adds the header without touching status or body", async () => {
    const timing = startTiming();
    const request = new Request("https://example.test/page");
    const html = new Response("<p>hi</p>", { status: 404, headers: { "content-type": "text/html; charset=utf-8", "x-keep": "1" } });
    const out = withServerTiming(request, html, timing, ctx);
    expect(out.status).toBe(404);
    expect(out.headers.get("x-keep")).toBe("1");
    expect(out.headers.get("server-timing")).toContain("total;dur=");
    expect(await out.text()).toBe("<p>hi</p>");

    const json = withServerTiming(request, Response.json({ ok: true }), timing, ctx);
    expect(await json.json()).toEqual({ ok: true });
    expect(json.headers.get("server-timing")).toContain("d1;dur=");
  });
});
