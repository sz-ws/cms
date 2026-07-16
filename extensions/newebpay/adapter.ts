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
    const [merchantId, hashKey, hashIv, env] = await Promise.all([
      this.services.settings.get<string>(KEY_MERCHANT_ID, ""),
      this.services.settings.get<string>(KEY_HASH_KEY, ""),
      this.services.settings.get<string>(KEY_HASH_IV, ""),
      this.services.settings.get<string>(KEY_ENV, "test"),
    ]);
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
    params.set("MerchantOrderNo", req.orderNo);
    params.set("Amt", String(req.amount));
    params.set("ItemDesc", description);
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
      orderNo: parsed.Result?.MerchantOrderNo ?? "",
      succeeded: parsed.Status === "SUCCESS",
      tradeNo: parsed.Result?.TradeNo,
      paymentType: parsed.Result?.PaymentType,
      payTime: parsed.Result?.PayTime,
      raw: plain,
      event: parsed,
    };
  }
}

export function createNewebPayAdapter(
  services: CoreServices,
): PaymentGatewayAdapter {
  return new NewebPayAdapter(services);
}
