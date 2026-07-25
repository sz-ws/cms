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

// payment-kit 引擎:所有金流共用的 PaymentProvider + CallbackReceiver 實作。
// 會變的部分(加密/驗簽/組包/解包)全部委派給 adapter;這裡只做:
//   - createCheckout:組回呼 URL → adapter.buildCheckout → 寫入 pending 訂單列
//   - verifyCallback:委派 adapter(fail closed)
//   - handleCallback:adapter.parseCallback → 訂單結算(冪等)→
//     payment:succeeded hook → return 模式回 HTML 結果頁(CORE_API 1.14.0
//     的 Response 透傳)

/** 訂單表名(ext_<id>_orders)—— 開發者常數,仍驗字元集擋 sql.raw 注入面。 */
const TABLE_RE = /^[a-z][a-z0-9_]{2,60}$/;

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

  /** 依 core.siteUrl 組回呼 URL;未設定 → 全空字串(adapter 決定省略欄位)。 */
  private async buildUrls(): Promise<GatewayUrls> {
    const site = await this.siteUrl();
    if (!site) return { notifyUrl: "", returnUrl: "", clientBackUrl: "" };
    return {
      notifyUrl: `${site}/api/callback/payment/${this.opts.providerId}`,
      returnUrl: `${site}/api/callback/payment/${this.opts.providerId}-return`,
      clientBackUrl: site,
    };
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const urls = await this.buildUrls();
    const session = await this.opts.adapter.buildCheckout(req, urls);
    if (!session.ok) return session;

    const now = Date.now();
    await this.opts.services.db.run(sql`
      INSERT INTO ${sql.raw(this.opts.table)}
        (order_no, amount, description, email, status, created_at, updated_at)
      VALUES
        (${req.orderNo}, ${req.amount}, ${req.description.trim()},
         ${req.email ?? null}, 'pending', ${now}, ${now})
    `);
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
      // 簽章對但解不開:不應發生(同一組金鑰),記錄後以失敗頁回應。
      console.error(
        `[payment-kit:${this.opts.providerId}] verified callback but payload undecodable`,
      );
      return this.opts.mode === "return"
        ? this.resultPage(false, "", await this.siteUrl())
        : undefined;
    }

    if (parsed.orderNo) {
      // Notify 與 Return 可能同時到達；以同一支條件式 UPDATE 爭取結算權。
      // 只有實際把列翻成 paid 的請求能拿到 RETURNING，因此 hook 不會重複觸發。
      const settled = await this.opts.services.db.all<{ orderNo: string }>(sql`
        UPDATE ${sql.raw(this.opts.table)} SET
          status = ${parsed.succeeded ? "paid" : "failed"},
          trade_no = ${parsed.tradeNo ?? null},
          payment_type = ${parsed.paymentType ?? null},
          pay_time = ${parsed.payTime ?? null},
          raw_result = ${parsed.raw},
          updated_at = ${Date.now()}
        WHERE order_no = ${parsed.orderNo} AND status <> 'paid'
        RETURNING order_no AS orderNo
      `);
      if (settled.length > 0 && parsed.succeeded) {
        await this.opts.services.hooks.doAction("payment:succeeded", {
          providerId: this.opts.providerId,
          event: parsed.event,
        });
      } else if (settled.length === 0) {
        // 保留原本「簽章有效但查無訂單」的診斷；這個查詢不參與結算判斷。
        const existing = await this.opts.services.db.get<{ orderNo: string }>(sql`
          SELECT order_no AS orderNo FROM ${sql.raw(this.opts.table)}
          WHERE order_no = ${parsed.orderNo}
        `);
        if (!existing) {
          // 簽章有效但查無此訂單:可能是別台環境共用同一組商店金鑰。記錄即可。
          console.warn(
            `[payment-kit:${this.opts.providerId}] callback for unknown order "${parsed.orderNo}"`,
          );
        }
      }
    }

    if (this.opts.mode === "return") {
      return this.resultPage(
        parsed.succeeded,
        parsed.orderNo,
        await this.siteUrl(),
      );
    }
    // notify:回 undefined → ingress 維持既有 {ok:true}(gateway 以 HTTP 200 判定收到)。
  }

  /** ReturnURL 的瀏覽器結果頁 —— 純靜態 HTML,白底單一焦點,無外部資源。 */
  private resultPage(
    succeeded: boolean,
    orderNo: string,
    siteUrl: string,
  ): Response {
    const title = succeeded ? "付款完成" : "付款未完成";
    const detail = succeeded
      ? "我們已收到您的款項。"
      : "交易未成功,未收取任何款項。";
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
  .order { margin-top: 12px; font-variant-numeric: tabular-nums; }
  .back { display: inline-block; margin-top: 24px; font-size: 14px;
          color: rgba(0,0,0,.85); text-underline-offset: 4px; }
</style>
</head>
<body>
<main>
  <div class="mark">${succeeded ? "✓" : "✕"}</div>
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
