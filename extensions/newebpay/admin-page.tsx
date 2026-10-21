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
import { HASH_IV_LENGTH, HASH_KEY_LENGTH } from "./crypto";

// 藍新金流 adminPage —— 設定狀態、測試付款、訂單一覽。
// 版面積木來自 @/ext/payment-kit/admin;本檔只剩藍新專屬的狀態列組合。

// 0.3.0:測試付款付完回到這一頁(index.ts 的 PaymentReturn),網址帶著 ?order=…&payment=…。
const TEST_RESULT: Record<string, { text: string; tone: string }> = {
  paid: { text: "測試付款完成，已經記成已付款（見下方訂單）。這是真的扣款，記得到藍新商店後台退款。", tone: "border-emerald-600/20 bg-emerald-600/[0.06] text-emerald-900" },
  failed: { text: "這次測試付款沒有成功，沒有扣款。", tone: "border-red-600/20 bg-red-600/[0.06] text-red-900" },
  back: { text: "測試付款沒有完成，沒有扣款。", tone: "border-ink/10 bg-ink/[0.03] text-ink/70" },
};

export async function NewebPayAdminPage({ searchParams }: { searchParams?: Record<string, string> } = {}) {
  const result = searchParams?.payment ? TEST_RESULT[searchParams.payment] : undefined;
  const resultOrder = /^[A-Za-z0-9_]{1,30}$/.test(searchParams?.order ?? "") ? searchParams?.order : undefined;
  const [merchantId, hashKey, hashIv, env, siteUrl, orders] = await Promise.all([
    getSetting<string>("ext.newebpay.merchantId", ""),
    getSetting<string>("ext.newebpay.hashKey", ""),
    getSetting<string>("ext.newebpay.hashIv", ""),
    getSetting<string>("ext.newebpay.env", "test"),
    getSetting<string>("core.siteUrl", ""),
    loadRecentOrders("ext_newebpay_orders"),
  ]);
  // 長度不對的金鑰,付款時和沒填一樣(adapter 的 loadConfig):多貼一個空白、少複製一個字,這裡就要看得出來。
  const keysFilled = Boolean(hashKey.trim() && hashIv.trim());
  const keysValid = hashKey.trim().length === HASH_KEY_LENGTH && hashIv.trim().length === HASH_IV_LENGTH;
  const configured = Boolean(merchantId.trim()) && keysValid;

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <header>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink/85">
          藍新金流
        </h1>
        <p className="mt-1 text-[13.5px] leading-relaxed text-ink/55">
          線上刷卡收款：客人在結帳頁選「線上刷卡」就會到藍新付款，付款成功後訂單會自動改成已付款。商店代號與金鑰在設定頁填寫。
        </p>
      </header>

      {result ? (
        <p role="status" className={`rounded-[10px] border px-4 py-3 text-[13.5px] leading-relaxed ${result.tone}`}>
          {resultOrder ? <span className="font-mono">{resultOrder}</span> : null}
          {resultOrder ? "：" : null}
          {result.text}
        </p>
      ) : null}

      {/* 狀態:金鑰在否 + 環境;網站網址沒設定時,付款結果傳不回來。 */}
      <section className={CARD}>
        <h2 className="mb-3 text-[15px] font-semibold tracking-[-0.01em] text-ink/85">
          狀態
        </h2>
        <div className="flex flex-col gap-2.5">
          <Row label="商店代號">
            {merchantId ? (
              <>
                <ConfiguredPill configured />
                <span className="font-mono text-[12.5px] text-ink/60">
                  {merchantId}
                </span>
              </>
            ) : (
              <ConfiguredPill configured={false} />
            )}
          </Row>
          <Row label="HashKey／HashIV">
            <ConfiguredPill configured={keysValid} />
            {keysFilled && !keysValid ? (
              <span className="text-amber-700">
                長度不對：HashKey 要 {HASH_KEY_LENGTH} 碼、HashIV 要 {HASH_IV_LENGTH} 碼，請到設定頁重新貼上。
              </span>
            ) : !configured ? (
              <span className="text-ink/50">
                三項都填好之前，客人沒辦法線上刷卡。
              </span>
            ) : null}
          </Row>
          <Row label="環境">
            <span className={`${PILL} ${env === "prod" ? PILL_GREEN : PILL_NEUTRAL}`}>
              {env === "prod" ? "正式機" : "測試機"}
            </span>
          </Row>
          {siteUrl ? null : (
            <Row label="付款結果">
              <span className="text-amber-700">
                網站網址還沒設定（設定頁的「一般」）。沒有它，客人付了款，訂單也會停在待付款。
              </span>
            </Row>
          )}
        </div>
      </section>

      {/* 測試付款:走完整真實路徑(checkout API → 藍新付款頁 → 回呼)。 */}
      <section className={CARD}>
        <h2 className="mb-2 text-[15px] font-semibold tracking-[-0.01em] text-ink/85">
          測試付款
        </h2>
        <p className="mb-4 text-[13px] leading-relaxed text-ink/55">
          環境是測試機時，用藍新的測試卡號 4000-2211-1111-1111，有效期限填未來的月年、末三碼任意，不會真的扣款。環境是正式機時會真的扣款。
        </p>
        <CheckoutTestForm
          endpoint="/api/ext/newebpay/checkout"
          disabled={!configured}
        />
      </section>

      {/* 訂單:最近 50 筆。 */}
      <section className={CARD}>
        <h2 className="mb-3 text-[15px] font-semibold tracking-[-0.01em] text-ink/85">
          訂單
        </h2>
        <PaymentOrdersTable orders={orders} />
      </section>
    </div>
  );
}
