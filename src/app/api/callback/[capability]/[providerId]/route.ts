import { getExtRuntime } from "@/ext/loader";
import { buildProviderRegistry } from "@/ext/services";
import { isCallbackReceiver } from "@/ext/capabilities";
import type { Capability } from "@/ext/capabilities";
import { hitRateLimit } from "@/lib/rate-limit";
import { declaredLengthExceeds, readBoundedText } from "@/lib/body-limit";

const MAX_BODY_BYTES = 64_000;


// core-v2 §2.5:Unified inbound callback / webhook ingress。
//
//   POST /api/callback/<capability>/<providerId>
//     e.g. /api/callback/payment/stripe
//          /api/callback/extraction/extend-ai
//          /api/callback/demo-callback/echo   (§2.5 DEMO)
//
// 這是 provider outbound 方法(charge/submit/put)的 inbound 對應:一個穩定、已驗證的
// URL,外部服務(payment gateway、extend.ai、OAuth)回呼於此,route 依 URL 內的
// (capability, providerId) 精確找到 provider 並委派驗證 + 處理。
//
// 安全(§2.5 + §5):
//   - **無 requireAuth、無 assertSameOrigin** —— 呼叫者是外部服務,cookie/Origin 不適用;
//     provider 的簽章檢查 **就是** 認證。
//   - **raw body 只讀一次**(await req.text()),原封不動交給 verifyCallback 做簽章比對;
//     在 verify 之前 **絕不 JSON.parse**(改動任何 byte 都會使簽章失效)。
//   - **不洩露失敗原因**:provider 不存在 / 未實作 callback / 簽章錯誤,對外都是通用訊息;
//     404 不區分「無此 provider」與「provider 不收 callback」。
//   - **先驗後處理**:handleCallback 僅在 verifyCallback 回 true 後才呼叫,未驗證的呼叫者
//     永遠到不了 handler。
//   - https 由平台在 prod 強制(dev localhost 不 hard-fail)。
//   - **Phase E §4 additions**: rate limit by client IP + (capability,
//     providerId) — 60/min, reusing the D1 counter from lib/rate-limit.ts
//     (this route has no session, so IP + path is the only available key).
//     Body-size guard(MAX_BODY_BYTES = 64KB):Content-Length 僅作為提早拒絕，
//     實際以 stream reader 累計並封頂，再交給 verify/handle，避免未驗證請求
//     先把任意大的 body 緩衝進 isolate。

async function handleCallback(
  req: Request,
  ctx: { params: Promise<{ capability: string; providerId: string }> },
): Promise<Response> {
  const { capability, providerId } = await ctx.params;

  // 0a. Rate limit by client IP + (capability, providerId) — public route, no
  // session to key on. 60/min per Phase E §4.
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  if (
    await hitRateLimit(`${ip}:${capability}:${providerId}`, {
      namespace: "callback",
      limit: 60,
      windowMs: 60_000,
    })
  ) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  // 0b. Content-Length 只能作為提早拒絕的提示；缺席或非數字一律不可信，仍由
  // 下方 reader 的累計位元組數強制上限。
  if (declaredLengthExceeds(req, MAX_BODY_BYTES)) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }

  // 1. raw body 只讀一次、串流封頂後才解碼，原樣保留供簽章驗證(§5 raw body preserved)。
  //    不觸發 Miniflare 對非 text/* Content-Type(如 payment gateway 的
  //    application/x-www-form-urlencoded)呼叫 .text() 的噪音警告。
  const rawBody = await readBoundedText(req, MAX_BODY_BYTES, "callback");
  if (rawBody === null) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }

  // 2. 建 registry(與 services.ts 相同:getExtRuntime → buildProviderRegistry)。
  //    含 enabled code extension 的 provides —— 這是 code extension(如 cron:tick/cron)
  //    的 callback provider 能被本 ingress 命中的前提(§2.2 接線後自動生效)。
  //    此路由無 session,但 handleCallback 需要 hooks 觸發 payment:succeeded 等。
  //    不需 resolveActive():callback 用 getById 精確命中 URL 指定的 providerId。
  const rt = await getExtRuntime();
  const registry = buildProviderRegistry(rt);

  // 3. 依 (capability, providerId) 精確查。null 或不收 callback → 404(不揭露何者)。
  const provider = registry.getById<unknown>(capability as Capability, providerId);
  if (!isCallbackReceiver(provider)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  // 4. 集中式簽章/HMAC 驗證 —— 這是認證。false → 403 通用訊息,不洩露原因(§2.5)。
  let verified: boolean;
  try {
    verified = await provider.verifyCallback(rawBody, req.headers);
  } catch (e) {
    // verify 內部錯誤:server 端記錄,對外仍當作驗證失敗(不透露細節)。
    console.error(
      `[callback] verify error capability="${capability}" provider="${providerId}"`,
      e,
    );
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (!verified) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  // 5. 已驗證 → 處理事件(更新 D1、觸發 hook)。handler 錯誤:server 端記錄 + 500 通用。
  //    只有通過 verify 的呼叫者能到這裡,未驗證者絕不觸發 handler。
  //    1.14.0:handler 可回傳 Response(payment ReturnURL 的 HTML 結果頁 / OAuth
  //    redirect —— 呼叫端是使用者瀏覽器,不是 server)。回傳時原樣轉發;否則維持
  //    既有 `{ok:true}`(server-to-server webhook 不受影響)。
  try {
    const result = await provider.handleCallback(rawBody, req.headers);
    if (result instanceof Response) return result;
  } catch (e) {
    console.error(
      `[callback] handler error capability="${capability}" provider="${providerId}"`,
      e,
    );
    return Response.json({ error: "internal_error" }, { status: 500 });
  }

  return Response.json({ ok: true }, { status: 200 });
}

export const POST = handleCallback;
