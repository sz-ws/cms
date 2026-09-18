"use client";

import { createContext, useContext, type ReactNode } from "react";
import { usePathname } from "next/navigation";

// 1.40.0:側欄標題 → 頁面標題。
//
// 站台可以用 filter:adminMenu 把「商城營運」改叫「訂單管理」,側欄與麵包屑跟著變,
// 但 extension 頁面自己的 <h1> 是寫死的,於是同一頁出現兩個名字。extension 頁面改用
// useAdminPageTitle("商城營運"):側欄有這個網址就用側欄的標題,沒有就用預設。

const AdminTitlesContext = createContext<Record<string, string>>({});

export function AdminTitlesProvider({
  titles,
  children,
}: {
  titles: Record<string, string>;
  children: ReactNode;
}) {
  return <AdminTitlesContext.Provider value={titles}>{children}</AdminTitlesContext.Provider>;
}

/** 目前頁面在側欄的標題;不在側欄(或不在 admin 殼內)時回 `fallback`。 */
export function useAdminPageTitle(fallback: string): string {
  const titles = useContext(AdminTitlesContext);
  const pathname = usePathname();
  return titles[pathname] ?? fallback;
}

/** server 元件裡用的版本:`<h1><AdminPageTitle fallback="訂單" /></h1>`。 */
export function AdminPageTitle({ fallback }: { fallback: string }) {
  return <>{useAdminPageTitle(fallback)}</>;
}
