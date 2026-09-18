"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, type ComponentProps } from "react";

// 後台內容區的連結(表格的列、卡片、分頁、篩選)。停在上面或 focus 到才預抓,
// 跟側欄的 AdminNavLink 同一個規則。
//
// 為什麼不用 next/link 的預設:後台頁面都是 dynamic,連結一進視窗就預抓,每一個預抓
// 都在伺服器跑一次後台 layout(session、設定、extension runtime 幾趟 D1)。一張 12 列
// 的表每次 router.refresh() 之後又全部重抓一輪 —— 12 次 layout 換一次「可能會點」。
// server component 也能直接放(props 只有 href、className、children)。
type AdminLinkProps = Omit<ComponentProps<typeof Link>, "href" | "prefetch"> & { href: string };

export function AdminLink({ href, onPointerEnter, onFocus, ...rest }: AdminLinkProps) {
  const router = useRouter();
  const prefetched = useRef(false);
  const prefetch = () => {
    if (prefetched.current) return;
    prefetched.current = true;
    router.prefetch(href);
  };
  return (
    <Link
      href={href}
      prefetch={false}
      onPointerEnter={(event) => {
        prefetch();
        onPointerEnter?.(event);
      }}
      onFocus={(event) => {
        prefetch();
        onFocus?.(event);
      }}
      {...rest}
    />
  );
}
