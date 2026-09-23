"use client";

import Link from "next/link";
import { useOptionalT } from "@/lib/i18n/I18nProvider";

// 1.50.0:訂單頁的「申請退貨」—— 打開退貨管理的「新增退貨」並帶好訂單編號(?order=)。
// 已出貨、已完成的訂單才該出現(呼叫端判斷)。受管訂單的插件頁也可以直接用。

const LINK =
  "inline-flex items-center rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] px-2.5 py-1 text-[12px] font-medium text-black/70 admin:text-ink/70 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)] transition-colors duration-150 hover:bg-black/[0.04] admin:hover:bg-ink/[0.04]";

export function StartReturnLink({
  returnsPage,
  orderNo,
  className,
}: {
  /** 退貨管理頁,如 "/admin/ext/shop/returns"。 */
  returnsPage: string;
  orderNo: string;
  className?: string;
}) {
  const t = useOptionalT();
  return (
    <Link href={`${returnsPage}?order=${encodeURIComponent(orderNo)}`} className={className ?? LINK}>
      {t?.("returns.startFromOrder") ?? "Start a return"}
    </Link>
  );
}
