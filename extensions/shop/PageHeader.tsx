import Link from "next/link";

// 商店頁的標題列:標題 + 右邊一個返回連結(選填)。購物車頁由 public-pages.tsx 的殼畫;結帳頁(0.11.0)
// 由 CheckoutView 自己畫,因為標題跟著結帳走到哪一步換:成立訂單之後是「訂單已成立」,沒有「回購物車」。
// 沒有 "use client":server 殼與 client 元件都能直接放。

export function PageHeader({
  title,
  backHref,
  backLabel,
}: {
  title: string;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <header className="mb-8 flex items-baseline justify-between gap-3">
      <h1 className="text-[24px] font-semibold tracking-[-0.02em] text-black/85">{title}</h1>
      {backHref ? (
        <Link href={backHref} className="text-[13px] text-black/55 underline underline-offset-4">
          {backLabel}
        </Link>
      ) : null}
    </header>
  );
}
