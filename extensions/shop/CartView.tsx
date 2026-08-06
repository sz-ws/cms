"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import {
  cartSubtotal,
  getCartServerSnapshot,
  getCartSnapshot,
  setQty,
  subscribeCart,
} from "./cart-store";

// 購物車頁(client)。localStorage 為源,useSyncExternalStore 訂閱
// (server snapshot 為空,hydration 後自動補上 client 值)。

const QTY_BTN =
  "grid h-7 w-7 place-items-center rounded-[8px] text-[14px] text-black/60 " +
  "shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)] hover:bg-black/[0.04]";

export function CartView() {
  const items = useSyncExternalStore(
    subscribeCart,
    getCartSnapshot,
    getCartServerSnapshot,
  );

  if (items.length === 0) {
    return (
      <p className="text-[14px] text-black/50">
        購物車是空的。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <ul className="divide-y divide-black/[0.06]">
        {items.map((item) => (
          <li key={item.productId} className="flex items-center gap-4 py-4">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14.5px] text-black/85">{item.name}</p>
              <p className="mt-0.5 text-[12.5px] tabular-nums text-black/45">
                NT$ {item.unitPrice.toLocaleString("zh-TW")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label={`減少 ${item.name} 數量`}
                className={QTY_BTN}
                onClick={() => setQty(item.productId, item.qty - 1)}
              >
                −
              </button>
              <span className="w-6 text-center text-[14px] tabular-nums text-black/80">
                {item.qty}
              </span>
              <button
                type="button"
                aria-label={`增加 ${item.name} 數量`}
                className={QTY_BTN}
                onClick={() => setQty(item.productId, item.qty + 1)}
              >
                +
              </button>
            </div>
            <p className="w-24 text-right text-[14px] tabular-nums text-black/80">
              NT$ {(item.unitPrice * item.qty).toLocaleString("zh-TW")}
            </p>
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-between border-t border-black/10 pt-5">
        <span className="text-[14px] text-black/55">小計</span>
        <span className="text-[18px] font-semibold tabular-nums tracking-[-0.01em] text-black/85">
          NT$ {cartSubtotal(items).toLocaleString("zh-TW")}
        </span>
      </div>
      <p className="-mt-4 text-right text-[12px] text-black/40">
        運費與最終金額於結帳時計算。
      </p>

      <Link
        href="/shop/checkout"
        className="grid h-11 place-items-center rounded-[12px] bg-black text-[14.5px] font-medium text-white hover:bg-black/85"
      >
        前往結帳
      </Link>
    </div>
  );
}
