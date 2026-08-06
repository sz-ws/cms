"use client";

import { useRef, useState } from "react";
import { addToCart } from "./cart-store";

// 加入購物車按鈕(client)。掛載位置:catalog 商品頁的 progressive 強化層
// (overrideRegistry 針對 public:catalog.product:detail 的 override),或任何
// 自訂商品版面。回饋為靜態文字切換(無 pulsing —— 專案紅線)。

export function AddToCartButton({
  productId,
  name,
  unitPrice,
  className,
}: {
  productId: string;
  name: string;
  /** 顯示用單價;結帳時伺服器重讀 catalog 計價。 */
  unitPrice: number;
  className?: string;
}) {
  const [added, setAdded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onClick() {
    addToCart({ productId, name, unitPrice });
    setAdded(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setAdded(false), 1600);
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={
        className ??
        "grid h-11 w-full place-items-center rounded-[12px] bg-black text-[14.5px] font-medium text-white hover:bg-black/85"
      }
    >
      {added ? "已加入購物車 ✓" : "加入購物車"}
    </button>
  );
}
