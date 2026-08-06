import { getSetting } from "@/lib/settings";
import {
  CARD,
  Row,
  ConfiguredPill,
  PaymentOrdersTable,
  loadRecentOrders,
} from "@/ext/payment-kit/admin";

// 銀行轉帳 adminPage —— 設定狀態與付款列一覽。
// 對帳(核可/退回)在 shop extension 的「對帳佇列」頁,那裡有訂單末五碼。

export async function BankTransferAdminPage() {
  const [bankName, bankCode, accountNumber, accountName, orders] =
    await Promise.all([
      getSetting<string>("ext.banktransfer.bankName", ""),
      getSetting<string>("ext.banktransfer.bankCode", ""),
      getSetting<string>("ext.banktransfer.accountNumber", ""),
      getSetting<string>("ext.banktransfer.accountName", ""),
      loadRecentOrders("ext_banktransfer_orders"),
    ]);
  const configured = Boolean(
    bankName.trim() && accountNumber.trim() && accountName.trim(),
  );

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <header>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-black/85">
          銀行轉帳
        </h1>
        <p className="mt-1 text-[13.5px] leading-relaxed text-black/55">
          匯款收款:結帳時向客人出示下方帳戶,客人回報末五碼後,到商店的
          「對帳佇列」核可入帳。收款帳戶到設定頁的 Extensions 區填寫。
        </p>
      </header>

      <section className={CARD}>
        <h2 className="mb-3 text-[15px] font-semibold tracking-[-0.01em] text-black/85">
          狀態
        </h2>
        <div className="flex flex-col gap-2.5">
          <Row label="收款帳戶">
            <ConfiguredPill configured={configured} />
            {configured ? (
              <span className="font-mono text-[12.5px] text-black/60">
                {bankName}
                {bankCode ? `(${bankCode})` : ""} {accountNumber}
              </span>
            ) : (
              <span className="text-black/50">
                銀行名稱、帳號、戶名填妥前,結帳頁不會出現匯款選項
                (fail-closed,createCheckout 回 not_configured)。
              </span>
            )}
          </Row>
          {configured ? <Row label="戶名">{accountName}</Row> : null}
        </div>
      </section>

      <section className={CARD}>
        <h2 className="mb-3 text-[15px] font-semibold tracking-[-0.01em] text-black/85">
          付款列
        </h2>
        <p className="mb-3 text-[13px] leading-relaxed text-black/55">
          每筆匯款訂單在此各有一列(pending → 核可後 paid)。核可動作在商店的
          對帳佇列 —— 那裡有客人回報的末五碼。
        </p>
        <PaymentOrdersTable orders={orders} />
      </section>
    </div>
  );
}
