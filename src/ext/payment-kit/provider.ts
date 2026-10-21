import { sql } from "drizzle-orm";
import { getSetting } from "@/lib/settings";
import type {
  CallbackReceiver,
  CheckoutRequest,
  CheckoutSession,
  PaymentProvider,
} from "../capabilities";
import type { CoreServices } from "../services";
import type { GatewayUrls, PaymentGatewayAdapter } from "./types";
import { settlePayment, TABLE_RE } from "./settle";
import { paymentReturnPath } from "./return-page";

// payment-kit 引擎:所有金流共用的 PaymentProvider + CallbackReceiver 實作。
// 會變的部分(加密/驗簽/組包/解包)全部委派給 adapter;這裡只做:
//   - createCheckout:組回呼 URL → adapter.buildCheckout → 寫入 pending 訂單列
//   - verifyCallback:委派 adapter(fail closed)
//   - handleCallback:adapter.parseCallback → 訂單結算(settle.ts,與人工核帳
//     共用的冪等結算 + payment:succeeded hook)→ return 模式回 HTML 結果頁
//     (CORE_API 1.14.0 的 Response 透傳)。1.78.0:有插件認得這筆訂單(PaymentReturn
//     插槽,return-page.ts)時,改成 303 轉去它給的站內頁;「返回商店」也連去那裡。

export interface PaymentProviderOptions {
  services: CoreServices;
  adapter: PaymentGatewayAdapter;
  /** notify 回呼的 providerId(return 回呼慣例為 `<providerId>-return`)。 */
  providerId: string;
  /** 訂單表名,如 "ext_newebpay_orders"(extension migration 建立)。 */
  table: string;
  /** notify = server-to-server(回 {ok:true});return = 瀏覽器導回(回 HTML)。 */
  mode: "notify" | "return";
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

class KitPaymentProvider implements PaymentProvider, CallbackReceiver {
  constructor(private readonly opts: PaymentProviderOptions) {
    if (!TABLE_RE.test(opts.table)) {
      throw new Error(`[payment-kit] invalid orders table name "${opts.table}"`);
    }
  }

  private async siteUrl(): Promise<string> {
    return (await getSetting<string>("core.siteUrl", ""))
      .trim()
      .replace(/\/+$/, "");
  }

  /** 依 core.siteUrl 組回呼 URL;未設定 → 全空字串(adapter 決定省略欄位)。返回商店:認得這筆的插件給的頁,沒有就首頁。 */
  private async buildUrls(orderNo: string): Promise<GatewayUrls> {
    const site = await this.siteUrl();
    if (!site) return { notifyUrl: "", returnUrl: "", clientBackUrl: "" };
    const back = await paymentReturnPath(this.opts.services.slots, orderNo, "back");
    return {
      notifyUrl: `${site}/api/callback/payment/${this.opts.providerId}`,
      returnUrl: `${site}/api/callback/payment/${this.opts.providerId}-return`,
      clientBackUrl: back ? `${site}${back}` : site,
    };
  }

  async getStatus(orderNo: string) {
    const row = await this.opts.services.db.get<{ status: "pending" | "paid" | "failed"; amount: number }>(sql`SELECT status, amount FROM ${sql.raw(this.opts.table)} WHERE order_no = ${orderNo}`);
    return row ?? null;
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const urls = await this.buildUrls(req.orderNo);
    const session = await this.opts.adapter.buildCheckout(req, urls);
    if (!session.ok) return session;

    const now = Date.now();
    await this.opts.services.db.run(sql`
      INSERT INTO ${sql.raw(this.opts.table)}
        (order_no, amount, description, email, status, created_at, updated_at)
      VALUES
        (${req.orderNo}, ${req.amount}, ${req.description.trim()},
         ${req.email ?? null}, 'pending', ${now}, ${now})
      ON CONFLICT(order_no) DO NOTHING
    `);
    const existing = await this.opts.services.db.get<{ amount: number; description: string; email: string | null }>(sql`SELECT amount, description, email FROM ${sql.raw(this.opts.table)} WHERE order_no = ${req.orderNo}`);
    if (!existing || existing.amount !== req.amount || existing.description !== req.description.trim() || existing.email !== (req.email ?? null)) return { ok: false, error: "idempotency_conflict" };
    return session;
  }

  // ---- CallbackReceiver ----

  async verifyCallback(rawBody: string): Promise<boolean> {
    return this.opts.adapter.verifyCallback(rawBody);
  }

  async handleCallback(rawBody: string): Promise<void | Response> {
    // verify 已通過才會到這裡(ingress 契約:先驗後處理)。
    const parsed = await this.opts.adapter.parseCallback(rawBody);
    if (!parsed) {
      // 簽章對但解不開:不知道付了沒有(1.78.1 以前這裡寫「交易未成功，未收取任何款項」,但錢可能已經扣了)。
      // 瀏覽器那頁說結果確認中、不要重複付款;server-to-server 回 500,不把沒讀到的通知當成收到了。
      console.error(
        `[payment-kit:${this.opts.providerId}] verified callback but payload undecodable`,
      );
      return this.opts.mode === "return"
        ? this.resultPage("unknown", "", await this.siteUrl())
        : Response.json({ ok: false, error: "undecodable" }, { status: 500 });
    }

    if (parsed.orderNo) {
      // Notify 與 Return 可能同時到達 —— settle.ts 以條件式 UPDATE 爭取結算權,
      // 冪等且 hook 不重複(與人工核帳共用同一段結算程式)。
      const outcome = await settlePayment(
        this.opts.services,
        this.opts.table,
        this.opts.providerId,
        {
          orderNo: parsed.orderNo,
          succeeded: parsed.succeeded,
          tradeNo: parsed.tradeNo,
          paymentType: parsed.paymentType,
          payTime: parsed.payTime,
          raw: parsed.raw,
          event: parsed.event,
        },
      );
      if (!outcome.settled && !outcome.known) {
        // 簽章有效但查無此訂單:可能是別台環境共用同一組商店金鑰。記錄即可。
        console.warn(
          `[payment-kit:${this.opts.providerId}] callback for unknown order "${parsed.orderNo}"`,
        );
      }
    }

    if (this.opts.mode === "return") {
      const site = await this.siteUrl();
      const page = site ? await paymentReturnPath(this.opts.services.slots, parsed.orderNo, parsed.succeeded ? "paid" : "failed") : null;
      // 303:金流是 POST 回來的,轉去的頁用 GET 打開(登入的 cookie 是 Lax,頂層 GET 會帶)。
      if (page) return Response.redirect(`${site}${page}`, 303);
      return this.resultPage(parsed.succeeded ? "paid" : "failed", parsed.orderNo, site);
    }
    // notify:回 undefined → ingress 維持既有 {ok:true}(gateway 以 HTTP 200 判定收到)。
  }

  /** ReturnURL 的瀏覽器結果頁 —— 純靜態 HTML,白底單一焦點,無外部資源。 */
  private resultPage(
    outcome: "paid" | "failed" | "unknown",
    orderNo: string,
    siteUrl: string,
  ): Response {
    const title = { paid: "付款完成", failed: "付款未完成", unknown: "付款結果確認中" }[outcome];
    const detail = {
      paid: "我們已收到您的款項。",
      failed: "交易未成功，未收取任何款項。",
      unknown: "還沒收到這筆付款的結果，請先不要重新付款。稍後查看訂單，或聯絡店家確認。",
    }[outcome];
    const mark = { paid: "✓", failed: "✕", unknown: "…" }[outcome];
    const orderLine = orderNo
      ? `<p class="order">訂單編號 ${escapeHtml(orderNo)}</p>`
      : "";
    const backLink = siteUrl
      ? `<a class="back" href="${escapeHtml(siteUrl)}">返回網站</a>`
      : "";
    const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #fff; color: rgba(0,0,0,.85);
         font-family: system-ui, -apple-system, "Chiron Hei HK", sans-serif;
         -webkit-font-smoothing: antialiased; }
  main { text-align: center; padding: 24px; }
  .mark { font-size: 40px; line-height: 1; }
  h1 { margin: 16px 0 8px; font-size: 22px; letter-spacing: -0.02em; }
  p { margin: 0; font-size: 14px; color: rgba(0,0,0,.55); }
  .order { margin-top: 12px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .back { display: inline-block; margin-top: 24px; font-size: 14px;
          color: rgba(0,0,0,.85); text-underline-offset: 4px; }
</style>
</head>
<body>
<main>
  <div class="mark">${mark}</div>
  <h1>${title}</h1>
  <p>${detail}</p>
  ${orderLine}
  ${backLink}
</main>
</body>
</html>`;
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

/** 組一個金流 provider:kit 引擎 + 該金流的 adapter。extension 的 provides.create 用。 */
export function createPaymentProvider(
  opts: PaymentProviderOptions,
): PaymentProvider & CallbackReceiver {
  return new KitPaymentProvider(opts);
}
