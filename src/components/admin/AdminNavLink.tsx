"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useSidebar } from "@/components/ui/intent/sidebar";

// 側欄的一列。**刻意不用 Intent 的 SidebarItem**:它底下是 react-aria 的 Link,
// 而 react-aria 的連結要靠 RouterProvider 才會走前端路由 —— 這個 repo 沒有裝,
// 所以每點一次側欄都是整頁重新載入(HTML 重算、JS 重跑、狀態全丟)。
// next/link 走 App Router 的軟導覽:只換內容區、loading.tsx 立刻出現。
//
// 停在連結上才預抓(prefetch={false} 關掉預設的「進視窗就抓」):admin 的頁面都是
// dynamic,每一次預抓都等於在伺服器跑一次 layout(session、settings、extension
// runtime 幾趟 D1)。側欄一次十幾條連結,進場就抓等於每次開後台多打幾十次 D1。
// 停留一下再抓,只會抓真的要去的那一頁。
interface AdminNavLinkProps {
  href: string;
  active: boolean;
  /** docked(收合成圖示列)時顯示的提示文字。 */
  tooltip?: string;
  className?: string;
  /** 點擊當下(軟導覽開始前)通知外層 —— 側欄用它立刻把這列標成選中。 */
  onNavigateStart?: (href: string) => void;
  children: ReactNode;
}

export function AdminNavLink({
  href,
  active,
  tooltip,
  className,
  onNavigateStart,
  children,
}: AdminNavLinkProps) {
  const router = useRouter();
  const { state, isMobile, setIsOpenOnMobile } = useSidebar();
  const prefetched = useRef(false);

  function prefetch() {
    if (prefetched.current) return;
    prefetched.current = true;
    router.prefetch(href);
  }

  // 離開後台的連結(插件放進側欄的前台頁,例如會員中心)在新分頁打開:後台留在原地,
  // 看完前台關掉分頁就回來。這種連結也不預抓、不標成選中。
  const leavesAdmin = !(href === "/admin" || href.startsWith("/admin/"));

  // 收合成圖示列時只剩圖示,標題靠瀏覽器原生提示交代。Intent 的 SidebarItem 是用
  // react-aria 的 Tooltip,但它要 trigger 也是 react-aria 元件才掛得上 hover ——
  // 這裡的 <a> 來自 next/link,掛不上,所以用 title。圖示列本來就是熟手模式。
  const docked = state === "collapsed" && !isMobile;

  const classes = cn(
    "group/nav relative flex items-center rounded-[calc(8px*var(--admin-radius-scale,1))] outline-hidden",
    "focus-visible:inset-ring focus-visible:inset-ring-sidebar-ring",
    className,
  );

  if (leavesAdmin) {
    return (
      <a href={href} target="_blank" rel="noopener" title={docked ? tooltip : undefined} className={classes}>
        {children}
      </a>
    );
  }

  return (
    <Link
      href={href}
      title={docked ? tooltip : undefined}
      prefetch={false}
      aria-current={active ? "page" : undefined}
      onPointerEnter={prefetch}
      onFocus={prefetch}
      onNavigate={() => {
        onNavigateStart?.(href);
        // 手機版側欄是一層 sheet。整頁重載的時代它會自己消失;改成軟導覽之後
        // 沒人關它,會蓋在剛開的頁面上。
        if (isMobile) setIsOpenOnMobile(false);
      }}
      className={classes}
    >
      {children}
    </Link>
  );
}
