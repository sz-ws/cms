// 量測用:每個請求在 D1、R2、KV、對外 fetch 各等了多久,寫進回應的 Server-Timing 標頭(瀏覽器開發者工具的
// Network → Timing 看得到),HTML 串流結束時再印一行完整的 JSON(`wrangler tail` 看得到)。
// 只在 Worker 變數 CMS_SERVER_TIMING = "1" 時打開(custom-worker.ts);沒設就完全不經過這裡。
//
// 做法:把這個請求的 env 換成一份包過的 —— D1、R2、KV binding 外面套一層 Proxy,每次呼叫計數、
// 計時。OpenNext 從 fetch 的 env 建請求的 Cloudflare context(getCloudflareContext),所以
// middleware、頁面、OpenNext 自己的快取(R2 增量快取、D1 tag cache)用的都是包過的這份。
//
// 讀數要知道的事:
// - Workers 的計時器只在 I/O 時前進(防 Spectre),純 CPU 的時間(渲染)量不到 —— 這裡量的是
//   「等 D1、等 R2」各多久;CPU 時間看 Cloudflare 儀表板或 tail 事件的 cpuTime。
// - 同時送出的查詢會重疊,dur 是各次加總,可能比整個請求還長。
// - 標頭在回應開始送出時就定了,串流途中的查詢只算進最後那行 log。
// - cold = 這個 isolate 接的第一個請求(冷啟動,要載入整包程式)。
// - 對外 fetch 是改全域的 fetch 來量(第一次量測時裝上,之後一直在);靠 AsyncLocalStorage
//   找到是哪個請求發的,同一個 isolate 同時處理好幾個請求也不會算錯人。

import { AsyncLocalStorage } from "node:async_hooks";

interface Bucket {
  n: number;
  ms: number;
}

export interface RequestTiming {
  /** 網站資料庫(DB)。 */
  d1: Bucket;
  /** OpenNext 的 tag cache(NEXT_TAG_CACHE_D1,同一個 D1)。 */
  tag: Bucket;
  /** OpenNext 的增量快取(NEXT_INC_CACHE_R2_BUCKET)。 */
  cache: Bucket;
  /** 媒體檔案(STORAGE)。 */
  r2: Bucket;
  /** 版本戳的 KV(CMS_KV,src/lib/stamps.ts);沒綁就一直是 0。 */
  kv: Bucket;
  /** 對外的 fetch 與 service binding(ASSETS、WORKER_SELF_REFERENCE)。 */
  fetch: Bucket;
  cold: boolean;
  start: number;
}

let firstRequest = true;

export function startTiming(): RequestTiming {
  const cold = firstRequest;
  firstRequest = false;
  const bucket = (): Bucket => ({ n: 0, ms: 0 });
  return { d1: bucket(), tag: bucket(), cache: bucket(), r2: bucket(), kv: bucket(), fetch: bucket(), cold, start: performance.now() };
}

const current = new AsyncLocalStorage<RequestTiming>();
let fetchPatched = false;

/** 在這個請求的範圍裡跑 run;範圍內的對外 fetch 會記到 timing.fetch。 */
export function runTimed<T>(timing: RequestTiming, run: () => T): T {
  if (!fetchPatched) {
    fetchPatched = true;
    const original = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const timing = current.getStore();
      return timing ? timed(timing.fetch, () => original(input, init)) : original(input, init);
    }) as typeof fetch;
  }
  return current.run(timing, run);
}

function timed<T>(bucket: Bucket, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  bucket.n += 1;
  return run().finally(() => {
    bucket.ms += performance.now() - start;
  });
}

// Proxy 包的是 runtime 的原生物件:取屬性時 receiver 用原物件、方法綁回原物件,不然會
// 「Illegal invocation」。batch 收到的是包過的 statement,要換回原物件才能交給原生的 batch。
const unwrapped = new WeakMap<object, object>();

function passThrough(target: object, prop: string | symbol): unknown {
  const value = Reflect.get(target, prop, target);
  return typeof value === "function" ? value.bind(target) : value;
}

const STATEMENT_RUNS = new Set<string | symbol>(["first", "all", "run", "raw"]);

function wrapStatement(statement: D1PreparedStatement, bucket: Bucket): D1PreparedStatement {
  const proxy = new Proxy(statement, {
    get(target, prop) {
      if (prop === "bind") return (...values: unknown[]) => wrapStatement(target.bind(...values), bucket);
      if (STATEMENT_RUNS.has(prop)) {
        const method = Reflect.get(target, prop, target) as (...args: unknown[]) => Promise<unknown>;
        return (...args: unknown[]) => timed(bucket, () => method.apply(target, args));
      }
      return passThrough(target, prop);
    },
  });
  unwrapped.set(proxy, statement);
  return proxy;
}

export function wrapD1(db: D1Database, bucket: Bucket): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrapStatement(target.prepare(sql), bucket);
      if (prop === "batch") {
        return (statements: D1PreparedStatement[]) =>
          timed(bucket, () => target.batch(statements.map((s) => (unwrapped.get(s) as D1PreparedStatement | undefined) ?? s)));
      }
      if (prop === "exec") return (sql: string) => timed(bucket, () => target.exec(sql));
      return passThrough(target, prop);
    },
  });
}

const R2_CALLS = new Set<string | symbol>(["get", "put", "head", "list", "delete"]);

export function wrapR2(bucketBinding: R2Bucket, bucket: Bucket): R2Bucket {
  return new Proxy(bucketBinding, {
    get(target, prop) {
      if (R2_CALLS.has(prop)) {
        const method = Reflect.get(target, prop, target) as (...args: unknown[]) => Promise<unknown>;
        return (...args: unknown[]) => timed(bucket, () => method.apply(target, args));
      }
      return passThrough(target, prop);
    },
  });
}

const KV_CALLS = new Set<string | symbol>(["get", "getWithMetadata", "put", "list", "delete"]);

export function wrapKv(namespace: KVNamespace, bucket: Bucket): KVNamespace {
  return new Proxy(namespace, {
    get(target, prop) {
      if (KV_CALLS.has(prop)) {
        const method = Reflect.get(target, prop, target) as (...args: unknown[]) => Promise<unknown>;
        return (...args: unknown[]) => timed(bucket, () => method.apply(target, args));
      }
      return passThrough(target, prop);
    },
  });
}

function wrapService<T extends { fetch: (...args: never[]) => Promise<Response> }>(service: T, bucket: Bucket): T {
  return new Proxy(service, {
    get(target, prop) {
      if (prop === "fetch") {
        const method = Reflect.get(target, prop, target) as unknown as (...args: unknown[]) => Promise<Response>;
        return (...args: unknown[]) => timed(bucket, () => method.apply(target, args));
      }
      return passThrough(target, prop);
    },
  });
}

/** 這個請求用的 env:會被量的 binding 換成包過的(沒設定的就不包),其他原樣。 */
export function timedEnv(env: CloudflareEnv, timing: RequestTiming): CloudflareEnv {
  const d1 = (db: D1Database | undefined, bucket: Bucket) => (db ? wrapD1(db, bucket) : db);
  const r2 = (binding: R2Bucket | undefined, bucket: Bucket) => (binding ? wrapR2(binding, bucket) : binding);
  // CMS_KV 是選用的 binding,型別不在 CloudflareEnv 裡(同 src/lib/stamps.ts 的讀法)。
  const kv = (env as unknown as { CMS_KV?: KVNamespace }).CMS_KV;
  return {
    ...env,
    DB: d1(env.DB, timing.d1),
    NEXT_TAG_CACHE_D1: d1(env.NEXT_TAG_CACHE_D1, timing.tag),
    NEXT_INC_CACHE_R2_BUCKET: r2(env.NEXT_INC_CACHE_R2_BUCKET, timing.cache),
    STORAGE: r2(env.STORAGE, timing.r2),
    ...(kv ? { CMS_KV: wrapKv(kv, timing.kv) } : {}),
    ...(env.ASSETS ? { ASSETS: wrapService(env.ASSETS, timing.fetch) } : {}),
    ...(env.WORKER_SELF_REFERENCE ? { WORKER_SELF_REFERENCE: wrapService(env.WORKER_SELF_REFERENCE, timing.fetch) } : {}),
  } as CloudflareEnv;
}

const ms = (value: number) => value.toFixed(1);

export function serverTimingHeader(timing: RequestTiming): string {
  const entry = (name: keyof Pick<RequestTiming, "d1" | "tag" | "cache" | "r2" | "kv" | "fetch">, what: string) =>
    `${name};dur=${ms(timing[name].ms)};desc="${timing[name].n} ${what}"`;
  const parts = [
    `total;dur=${ms(performance.now() - timing.start)}`,
    entry("d1", "queries"),
    entry("tag", "queries"),
    entry("cache", "reads"),
    entry("r2", "calls"),
    entry("kv", "calls"),
    entry("fetch", "calls"),
  ];
  if (timing.cold) parts.push(`cold;desc="first request in isolate"`);
  return parts.join(", ");
}

export function timingLogLine(request: Request, status: number, timing: RequestTiming): string {
  const bucket = (b: Bucket) => ({ n: b.n, ms: Number(ms(b.ms)) });
  return JSON.stringify({
    serverTiming: {
      path: new URL(request.url).pathname,
      status,
      totalMs: Number(ms(performance.now() - timing.start)),
      d1: bucket(timing.d1),
      tag: bucket(timing.tag),
      cache: bucket(timing.cache),
      r2: bucket(timing.r2),
      kv: bucket(timing.kv),
      fetch: bucket(timing.fetch),
      cold: timing.cold,
    },
  });
}

/**
 * 回應加上 Server-Timing。HTML 另外接一段直通的串流,等最後一個 byte 送完才印完整的 log
 * (串流途中的查詢也算進去);其他回應回傳時就印。WebSocket 升級原樣回傳。
 */
export function withServerTiming(request: Request, response: Response, timing: RequestTiming, ctx: ExecutionContext): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.append("Server-Timing", serverTimingHeader(timing));
  const html = response.body && (headers.get("content-type") ?? "").includes("text/html");
  if (!html) {
    console.log(timingLogLine(request, response.status, timing));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  const { readable, writable } = new TransformStream();
  ctx.waitUntil(
    response.body!.pipeTo(writable).then(
      () => console.log(timingLogLine(request, response.status, timing)),
      () => undefined, // 使用者中途離開:不記
    ),
  );
  return new Response(readable, { status: response.status, statusText: response.statusText, headers });
}
