import { AdminPageLoading } from "@/components/admin/AdminPageLoading";

// 05 §1:admin 的 Suspense 邊界。放在 layout 底下,所以換頁時側欄與頂欄留在原地,
// 只有內容區換成置中的轉圈 —— 點側欄立刻有反應,不必等伺服器把整頁算完。
//
// 它同時是 next/link 預抓的終點:admin 的頁面都是 dynamic,預抓只會抓到這層為止
// (見 AdminNavLink 對預抓時機的說明)。
export default function AdminLoading() {
  return <AdminPageLoading />;
}
