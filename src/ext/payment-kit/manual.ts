import { sql } from "drizzle-orm";
import type {
  CheckoutRequest,
  CheckoutSession,
  ManualInstructionLine,
  PaymentProvider,
} from "../capabilities";
import type { CoreServices } from "../services";
import { settlePayment, TABLE_RE, type SettleOutcome } from "./settle";

// payment-kit:人工收款引擎(1.28.0)—— 「沒有 gateway」的付款方式(銀行轉帳/
// ATM/面交)。與 gateway 引擎(provider.ts)的差異只有兩點:
//   1. createCheckout 不組包加密 —— 回 kind:"manual" 的付款指示(收款帳號等,
//      由 extension 的 instructions() 從自家 settings 組出)。
//   2. 沒有回呼 —— 結算入口是 admin 的人工核帳:settleManual(),走與 gateway
//      回呼**同一段** settle.ts(冪等 + payment:succeeded)。消費端(commerce)
//      因此完全不需要分辨「這筆是刷卡還是匯款」。
//
// 為什麼不是 PaymentGatewayAdapter:那個契約的核心是 verifyCallback/parseCallback
// (回呼驗簽/解包),人工收款根本沒有回呼 —— 硬塞會得到兩個永遠回 false/null 的
// 方法。人工收款是第一類公民,不是殘缺的 gateway。

/** instructions() 的回傳:付款指示,或設定缺失時的錯誤(同 not_configured 精神)。 */
export type ManualInstructionsResult =
  | { ok: true; instructions: ManualInstructionLine[]; note?: string }
  | { ok: false; error: string };

export interface ManualPaymentProviderOptions {
  services: CoreServices;
  /** provides 註冊的 providerId,如 "banktransfer"。 */
  providerId: string;
  /** 訂單表名,如 "ext_banktransfer_orders"(extension migration 建立,欄位同 kit 契約)。 */
  table: string;
  /**
   * 依請求組付款指示(讀自家 settings:收款銀行/帳號/戶名…)。設定缺失回
   * { ok:false, error:"not_configured" },不 throw。
   */
  instructions: (req: CheckoutRequest) => Promise<ManualInstructionsResult>;
}

/** 人工收款 provider:PaymentProvider + admin 核帳入口。 */
export interface ManualPaymentProvider extends PaymentProvider {
  /**
   * 人工核帳(admin 動作)。succeeded=true → paid + payment:succeeded hook;
   * false → failed(不觸發 hook)。冪等 —— 已 paid 的單再核回 settled:false。
   * note 存入 raw_result(對帳紀錄,如「核可 by admin@site 末五碼 12345」)。
   */
  settleManual(
    orderNo: string,
    succeeded: boolean,
    note?: string,
  ): Promise<SettleOutcome>;
}

class KitManualPaymentProvider implements ManualPaymentProvider {
  constructor(private readonly opts: ManualPaymentProviderOptions) {
    if (!TABLE_RE.test(opts.table)) {
      throw new Error(`[payment-kit] invalid orders table name "${opts.table}"`);
    }
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const built = await this.opts.instructions(req);
    if (!built.ok) return built;

    const now = Date.now();
    await this.opts.services.db.run(sql`
      INSERT INTO ${sql.raw(this.opts.table)}
        (order_no, amount, description, email, status, created_at, updated_at)
      VALUES
        (${req.orderNo}, ${req.amount}, ${req.description.trim()},
         ${req.email ?? null}, 'pending', ${now}, ${now})
    `);
    return {
      ok: true,
      kind: "manual",
      providerId: this.opts.providerId,
      instructions: built.instructions,
      note: built.note,
    };
  }

  async settleManual(
    orderNo: string,
    succeeded: boolean,
    note?: string,
  ): Promise<SettleOutcome> {
    return settlePayment(this.opts.services, this.opts.table, this.opts.providerId, {
      orderNo,
      succeeded,
      paymentType: "MANUAL",
      payTime: new Date().toISOString(),
      raw: note,
      event: { manual: true, orderNo, note },
    });
  }
}

/** 組一個人工收款 provider。extension 的 provides.create 用(同 createPaymentProvider)。 */
export function createManualPaymentProvider(
  opts: ManualPaymentProviderOptions,
): ManualPaymentProvider {
  return new KitManualPaymentProvider(opts);
}

/** 型別守衛:provider 是否支援人工核帳(admin 核帳 route 用)。 */
export function isManualPaymentProvider(
  impl: unknown,
): impl is ManualPaymentProvider {
  if (impl === null || typeof impl !== "object") return false;
  const cand = impl as Partial<ManualPaymentProvider>;
  return (
    typeof cand.createCheckout === "function" &&
    typeof cand.settleManual === "function"
  );
}
