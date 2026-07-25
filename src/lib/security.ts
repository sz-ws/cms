// 04 §5:Origin 檢查(CSRF 防線)。所有以 cookie session 認證的 mutation
// (POST/PUT/PATCH/DELETE)route handler 開頭必須顯式呼叫 assertSameOrigin(req)。
// 不放 middleware,保持可見性。

export class OriginError extends Error {
  constructor() {
    super("bad_origin");
  }
}

/**
 * Origin header 與 request URL 的 scheme+host+port 精確字串比對。
 * Origin 缺失或為 "null" → 一律 throw OriginError(v1 單網域,無跨源需求)。
 */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") throw new OriginError();
  const target = new URL(req.url).origin; // scheme+host+port
  if (origin !== target) throw new OriginError();
}

/** route handler 共用:OriginError → 403 JSON;否則 null(交給後續處理) */
export function originErrorResponse(e: unknown): Response | null {
  if (e instanceof OriginError) {
    return Response.json({ error: "bad_origin" }, { status: 403 });
  }
  return null;
}

/**
 * 定時比較兩個字串。用在任何「拿使用者送來的值跟伺服器上的祕密比對」的地方:
 * `===` 會在第一個不同的位元組就返回,回應時間因此洩漏「猜對了幾個字元」,
 * 讓 token 可以被逐字元試出來。
 *
 * 長度不同時仍然跑完整輪比對(拿較長的那個當基準),否則長度本身就是側通道。
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  // 長度不同一定不相等,但仍要付出等量的比對成本。
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}
