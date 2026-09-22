"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { AdminIconSet } from "@/lib/admin-theme";

// 側欄用哪一套圖示(後台風格的 icons 欄位)。AdminTheme 依已存的風格提供,風格編輯器
// 的預覽另外包一層草稿值。沒有 provider 時是預設的實心。

const AdminIconSetContext = createContext<AdminIconSet>("solid");

export function AdminIconSetProvider({ value, children }: { value: AdminIconSet; children: ReactNode }) {
  return <AdminIconSetContext.Provider value={value}>{children}</AdminIconSetContext.Provider>;
}

export function useAdminIconSet(): AdminIconSet {
  return useContext(AdminIconSetContext);
}
