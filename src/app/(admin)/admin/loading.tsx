import { AdminPageSkeleton } from "@/components/admin/AdminPageSkeleton";

// 05 §1:admin 的 Suspense 邊界。放在 layout 底下,所以換頁時側欄與頂欄留在原地,
// 只有內容區換成骨架 —— 點側欄立刻有反應,不必等伺服器把整頁算完。
//
// 它同時是 next/link 預抓的終點:admin 的頁面都是 dynamic,預抓只會抓到這層為止
// (見 AdminNavLink 對預抓時機的說明)。
export default function AdminLoading() {
  return <AdminPageSkeleton />;
}
