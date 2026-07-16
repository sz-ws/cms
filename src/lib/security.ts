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
