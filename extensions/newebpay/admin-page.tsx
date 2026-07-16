import { getSetting } from "@/lib/settings";
import {
  CARD,
  PILL,
  PILL_GREEN,
  PILL_NEUTRAL,
  Row,
  ConfiguredPill,
  PaymentOrdersTable,
  loadRecentOrders,
} from "@/ext/payment-kit/admin";
import { CheckoutTestForm } from "@/ext/payment-kit/CheckoutTestForm";

// 藍新金流 adminPage —— 設定狀態、測試付款、訂單一覽。
// 版面積木來自 @/ext/payment-kit/admin;本檔只剩藍新專屬的狀態列組合。

export async function NewebPayAdminPage() {
  const [merchantId, hashKey, hashIv, env, siteUrl, orders] = await Promise.all([
    getSetting<string>("ext.newebpay.merchantId", ""),
    getSetting<string>("ext.newebpay.hashKey", ""),
    getSetting<string>("ext.newebpay.hashIv", ""),
    getSetting<string>("ext.newebpay.env", "test"),
    getSetting<string>("core.siteUrl", ""),
    loadRecentOrders("ext_newebpay_orders"),
  ]);
  const configured = Boolean(merchantId && hashKey && hashIv);
  const notifyUrl = `${siteUrl.replace(/\/+$/, "")}/api/callback/payment/newebpay`;

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <header>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-black/85">
          藍新金流
        </h1>
        <p className="mt-1 text-[13.5px] leading-relaxed text-black/55">
          NewebPay MPG 2.0 收款。這個 extension 提供 payment
          capability(其他模組可透過 provider registry
          建立結帳)、付款回呼驗簽處理與訂單記錄。商店金鑰到設定頁的
          Extensions 區填寫。
        </p>
      </header>

      {/* 狀態:金鑰在否 + 環境 + 回呼 URL。 */}
      <section className={CARD}>
        <h2 className="mb-3 text-[15px] font-semibold tracking-[-0.01em] text-black/85">
          狀態
        </h2>
        <div className="flex flex-col gap-2.5">
          <Row label="Merchant ID">
            {merchantId ? (
              <>
                <ConfiguredPill configured />
                <span className="font-mono text-[12.5px] text-black/60">
                  {merchantId}
                </span>
              </>
            ) : (
              <ConfiguredPill configured={false} />
            )}
          </Row>
          <Row label="Hash Key / IV">
            <ConfiguredPill configured={Boolean(hashKey && hashIv)} />
            {!configured && (
              <span className="text-black/50">
                三項皆填妥前,付款入口關閉(fail-closed,拒收所有回呼)。
              </span>
            )}
          </Row>
          <Row label="環境">
            <span className={`${PILL} ${env === "prod" ? PILL_GREEN : PILL_NEUTRAL}`}>
              {env === "prod" ? "正式機" : "測試機"}
            </span>
          </Row>
          <Row label="Notify URL">
            {siteUrl ? (
              <code className="break-all font-mono text-[12px] text-black/60">
                {notifyUrl}
              </code>
            ) : (
              <span className="text-amber-700">
                尚未設定 Site URL(設定頁 General 區)—— 藍新收不到付款通知,
                訂單會停在「待付款」。
              </span>
            )}
          </Row>
        </div>
      </section>

      {/* 測試付款:走完整真實路徑(checkout API → 藍新付款頁 → 回呼)。 */}
      <section className={CARD}>
        <h2 className="mb-2 text-[15px] font-semibold tracking-[-0.01em] text-black/85">
          測試付款
        </h2>
        <p className="mb-4 text-[13px] leading-relaxed text-black/55">
          建立一筆訂單並跳轉到藍新付款頁(依上方環境設定)。測試機用藍新提供的
          測試卡號;付款結果由 Notify 回呼寫回下方訂單表。
        </p>
        <CheckoutTestForm
          endpoint="/api/ext/newebpay/checkout"
          disabled={!configured}
        />
      </section>

      {/* 訂單:最近 50 筆。 */}
      <section className={CARD}>
        <h2 className="mb-3 text-[15px] font-semibold tracking-[-0.01em] text-black/85">
          訂單
        </h2>
        <PaymentOrdersTable orders={orders} />
      </section>
    </div>
  );
}
