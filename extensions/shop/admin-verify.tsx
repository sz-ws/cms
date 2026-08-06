import Link from "next/link";
import { getSetting } from "@/lib/settings";
import {
  TransferVerifyQueue,
  loadOrders,
} from "@/ext/commerce-kit/admin";

// 商店 adminPage:對帳佇列 —— 匯款的人工閘口(台灣無 open banking,到帳只有
// 店家看得到,所以狀態切換是人工一級公民)。兩區:
//   1. 待對帳(awaiting_verify):客人已回報末五碼 → 核可/退回。
//   2. 等待匯款(pending_payment 的匯款訂單):客人還沒回報 —— 銀行對到帳
//      也可直接「標記已收款」,不必等回報。
// 核可 → settleManual → payment:succeeded → 訂單 paid;退回 → 回待付款。

const ORDERS_TABLE = "ext_shop_orders";

export async function ShopVerifyPage() {
  const [orders, pending, transferProvider] = await Promise.all([
    loadOrders(ORDERS_TABLE, { status: "awaiting_verify", limit: 100 }),
    loadOrders(ORDERS_TABLE, { status: "pending_payment", limit: 100 }),
    getSetting<string>("ext.shop.transferProvider", ""),
  ]);
  const waitingTransfer = pending.filter(
    (o) => o.paymentProvider === transferProvider.trim(),
  );

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <header>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-black/85">
          對帳佇列
        </h1>
        <p className="mt-1 text-[13.5px] leading-relaxed text-black/55">
          客人回報匯款後在此對帳:以末五碼比對銀行入帳紀錄,核可即入帳
          (訂單標記已付款),對不到就退回(訂單回到待付款,客人可重新回報)。
          收款帳戶設定在
          <Link href="/admin/ext/banktransfer" className="underline underline-offset-4">
            銀行轉帳
          </Link>
          。
        </p>
      </header>

      <section>
        <h2 className="mb-3 text-[15px] font-semibold tracking-[-0.01em] text-black/85">
          待對帳(已回報)
        </h2>
        <TransferVerifyQueue orders={orders} actionsEndpoint="/api/ext/shop" />
      </section>

      <section>
        <h2 className="mb-1 text-[15px] font-semibold tracking-[-0.01em] text-black/85">
          等待匯款(未回報)
        </h2>
        <p className="mb-3 text-[12.5px] leading-relaxed text-black/50">
          客人還沒回報末五碼的匯款訂單。銀行對到入帳可直接標記已收款,不必等回報。
        </p>
        <TransferVerifyQueue
          orders={waitingTransfer}
          actionsEndpoint="/api/ext/shop"
          directPaid
          emptyText="目前沒有等待匯款的訂單。"
        />
      </section>
    </div>
  );
}
