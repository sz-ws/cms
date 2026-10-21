import { sql } from "drizzle-orm";
import type {
  GatewayUrls,
  ParsedCallback,
  PaymentGatewayAdapter,
} from "@/ext/payment-kit";
import { timingSafeEqual } from "@/ext/payment-kit";
import type { CheckoutRequest, CheckoutSession } from "@/ext/capabilities";
import type { CoreServices } from "@/ext/services";
import {
  decryptTradeInfo,
  encryptTradeInfo,
  tradeSha,
  HASH_KEY_LENGTH,
  HASH_IV_LENGTH,
} from "./crypto";

// 藍新金流的 PaymentGatewayAdapter —— payment-kit 引擎裡「會變的部分」全在這:
// 金鑰設定讀取、藍新的請求限制、TradeInfo/TradeSha 組包、回呼驗簽與解包。
// 訂單表讀寫 / 冪等結算 / hook / 結果頁都在 kit,這裡一概不碰。
//
// 設定(admin 設定頁 → Extensions 區;hashKey/hashIv 為 secret,AES-GCM 加密儲存):
//   ext.newebpay.merchantId / ext.newebpay.hashKey / ext.newebpay.hashIv /
//   ext.newebpay.env("test" = 測試機 ccore、"prod" = 正式機 core)

const KEY_MERCHANT_ID = "ext.newebpay.merchantId";
const KEY_HASH_KEY = "ext.newebpay.hashKey";
const KEY_HASH_IV = "ext.newebpay.hashIv";
const KEY_ENV = "ext.newebpay.env";

const GATEWAY_URL: Record<"test" | "prod", string> = {
  test: "https://ccore.newebpay.com/MPG/mpg_gateway",
  prod: "https://core.newebpay.com/MPG/mpg_gateway",
};

const MPG_VERSION = "2.0";
// 藍新限制:MerchantOrderNo ≤30 字元,限英數與底線。
const ORDER_NO_RE = /^[A-Za-z0-9_]{1,30}$/;
/** kit 的訂單表(index.ts 的 provides 用同一張)。 */
export const ORDERS_TABLE = "ext_newebpay_orders";
// 0.2.0:同一張訂單第二次以後去付款(我的訂單的「前往安全付款頁」、刷卡失敗再試、從藍新按
// 上一頁回來再送一次),送藍新的 MerchantOrderNo 要換一個 —— 藍新同一商店的商店訂單編號
// 不能重複,一送到付款頁就算用過(重新整理付款頁都會回 MPG03008)。第一次沿用訂單編號;
// 之後是「訂單編號前 21 字 + "_" + 秒數 36 進位 + 2 個亂數」,≤30 字;後綴裡沒有底線。
// 回呼帶回的是那次的號碼,parseCallback 對回原本的訂單(orderNoFor)。
const RETRY_PREFIX_LENGTH = 21;
// ItemDesc ≤50 字元(手冊上限;UTF-8 中文亦以字元計)。
const MAX_DESC_LENGTH = 50;

interface MerchantConfig {
  merchantId: string;
  hashKey: string;
  hashIv: string;
  env: "test" | "prod";
}

/** 藍新 Notify/Return 解密後的 JSON(RespondType=JSON;僅列本 adapter 消費的欄位)。 */
interface NewebPayResult {
  Status: string; // "SUCCESS" 或錯誤代碼
  Message?: string;
  Result?: {
    MerchantOrderNo?: string;
    TradeNo?: string;
    PaymentType?: string;
    PayTime?: string;
    Amt?: number;
  };
}

class NewebPayAdapter implements PaymentGatewayAdapter {
  constructor(private readonly services: CoreServices) {}

  /** 讀取並驗證商店設定;缺任一項或長度不合 → null(呼叫端 fail closed)。 */
  private async loadConfig(): Promise<MerchantConfig | null> {
    // 0.2.0:前後的空白去掉(從藍新後台複製時常多帶一個),金鑰本身不會有空白。
    const [merchantId, hashKey, hashIv, env] = (await Promise.all([
      this.services.settings.get<string>(KEY_MERCHANT_ID, ""),
      this.services.settings.get<string>(KEY_HASH_KEY, ""),
      this.services.settings.get<string>(KEY_HASH_IV, ""),
      this.services.settings.get<string>(KEY_ENV, "test"),
    ])).map((value) => String(value ?? "").trim());
    if (!merchantId || !hashKey || !hashIv) return null;
    if (hashKey.length !== HASH_KEY_LENGTH || hashIv.length !== HASH_IV_LENGTH) {
      return null;
    }
    return {
      merchantId,
      hashKey,
      hashIv,
      env: env === "prod" ? "prod" : "test",
    };
  }

  async buildCheckout(
    req: CheckoutRequest,
    urls: GatewayUrls,
  ): Promise<CheckoutSession> {
    if (!ORDER_NO_RE.test(req.orderNo)) {
      return { ok: false, error: "invalid_order_no" };
    }
    if (
      !Number.isInteger(req.amount) ||
      req.amount < 1 ||
      req.amount > 99_999_999
    ) {
      return { ok: false, error: "invalid_amount" };
    }
    const description = req.description.trim();
    if (description.length === 0 || description.length > MAX_DESC_LENGTH) {
      return { ok: false, error: "invalid_description" };
    }

    const config = await this.loadConfig();
    if (!config) return { ok: false, error: "not_configured" };

    const params = new URLSearchParams();
    params.set("MerchantID", config.merchantId);
    params.set("RespondType", "JSON");
    params.set("TimeStamp", String(Math.floor(Date.now() / 1000)));
    params.set("Version", MPG_VERSION);
    params.set("MerchantOrderNo", await this.merchantOrderNo(req.orderNo));
    params.set("Amt", String(req.amount));
    params.set("ItemDesc", description);
    // 0.2.0:只開信用卡。結帳頁寫的是「線上刷卡」;沒帶任何付款方式時藍新會列出商店後台開的
    // 全部方式,ATM、超商代碼是先取號、幾天後才付,可能付在訂單過了付款期限、被取消之後。
    params.set("CREDIT", "1");
    if (req.email) params.set("Email", req.email);
    // siteUrl 未設定時 urls 為空字串 → 省略回呼欄位:仍能到達藍新付款頁測 UI,
    // 但收不到付款結果,訂單停在 pending(admin 頁有對應提示)。
    if (urls.notifyUrl) params.set("NotifyURL", urls.notifyUrl);
    if (urls.returnUrl) params.set("ReturnURL", urls.returnUrl);
    if (urls.clientBackUrl) params.set("ClientBackURL", urls.clientBackUrl);

    const tradeInfo = await encryptTradeInfo(
      params.toString(),
      config.hashKey,
      config.hashIv,
    );
    const sha = await tradeSha(tradeInfo, config.hashKey, config.hashIv);

    return {
      ok: true,
      kind: "form-post",
      gatewayUrl: GATEWAY_URL[config.env],
      fields: {
        MerchantID: config.merchantId,
        TradeInfo: tradeInfo,
        TradeSha: sha,
        Version: MPG_VERSION,
      },
    };
  }

  /** 這次要送藍新的 MerchantOrderNo:這張訂單還沒送過就是訂單編號本身,送過就換一個(檔頭 0.2.0)。 */
  private async merchantOrderNo(orderNo: string): Promise<string> {
    const sent = await this.services.db.get<{ hit: number }>(
      sql`SELECT 1 AS hit FROM ${sql.raw(ORDERS_TABLE)} WHERE order_no = ${orderNo}`,
    );
    if (!sent) return orderNo;
    return `${orderNo.slice(0, RETRY_PREFIX_LENGTH)}_${retrySuffix()}`;
  }

  /**
   * 回呼的 MerchantOrderNo → 訂單編號。完全相同的訂單優先;否則拿最後一個底線之前那段當開頭
   * 找,只認唯一一筆(找不到或不只一筆就原樣交回,kit 當作查無此單)。
   */
  private async orderNoFor(merchantOrderNo: string): Promise<string> {
    const table = sql.raw(ORDERS_TABLE);
    const exact = await this.services.db.get<{ hit: number }>(
      sql`SELECT 1 AS hit FROM ${table} WHERE order_no = ${merchantOrderNo}`,
    );
    if (exact) return merchantOrderNo;
    const cut = merchantOrderNo.lastIndexOf("_");
    if (cut <= 0) return merchantOrderNo;
    const prefix = merchantOrderNo.slice(0, cut);
    const rows = await this.services.db.all<{ orderNo: string }>(
      sql`SELECT order_no AS orderNo FROM ${table} WHERE substr(order_no, 1, ${prefix.length}) = ${prefix} LIMIT 2`,
    );
    return rows.length === 1 ? rows[0].orderNo : merchantOrderNo;
  }

  async verifyCallback(rawBody: string): Promise<boolean> {
    const config = await this.loadConfig();
    if (!config) return false; // fail closed:未設定不放行任何回呼。

    const form = new URLSearchParams(rawBody);
    const tradeInfo = form.get("TradeInfo");
    const providedSha = form.get("TradeSha");
    if (!tradeInfo || !providedSha) return false;

    const expected = await tradeSha(tradeInfo, config.hashKey, config.hashIv);
    return timingSafeEqual(expected, providedSha.trim().toUpperCase());
  }

  async parseCallback(rawBody: string): Promise<ParsedCallback | null> {
    // verify 已通過才會被呼叫;config 必然存在(verify fail closed)。
    const config = await this.loadConfig();
    if (!config) return null;

    const form = new URLSearchParams(rawBody);
    const plain = await decryptTradeInfo(
      form.get("TradeInfo") ?? "",
      config.hashKey,
      config.hashIv,
    );
    if (!plain) return null;

    let parsed: NewebPayResult;
    try {
      parsed = JSON.parse(plain) as NewebPayResult;
    } catch {
      return null;
    }

    return {
      orderNo: await this.orderNoFor(parsed.Result?.MerchantOrderNo ?? ""),
      succeeded: parsed.Status === "SUCCESS",
      tradeNo: parsed.Result?.TradeNo,
      paymentType: parsed.Result?.PaymentType,
      payTime: parsed.Result?.PayTime,
      raw: plain,
      event: parsed,
    };
  }
}

/** 秒數(36 進位)+ 2 個亂數英數:同一秒連按兩次也拿到不同號碼。 */
function retrySuffix(): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(2)), (b) => (b % 36).toString(36)).join("");
  return `${Math.floor(Date.now() / 1000).toString(36)}${random}`;
}

export function createNewebPayAdapter(
  services: CoreServices,
): PaymentGatewayAdapter {
  return new NewebPayAdapter(services);
}
