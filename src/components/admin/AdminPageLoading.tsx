"use client";

import { useT } from "@/lib/i18n/I18nProvider";
import { LoadingState } from "./LoadingState";

// 換頁時佔住內容區(admin/loading.tsx 用它)。側欄與頂欄不動,內容區中間一個吃主色的
// 轉圈 —— 跟插件頁自己的「載入中」是同一個元件、同一個位置,換頁時不會先出一版貼在
// 左上角的骨架再跳成置中的轉圈。
export function AdminPageLoading() {
  const t = useT();
  return <LoadingState label={t("admin.loading")} />;
}
