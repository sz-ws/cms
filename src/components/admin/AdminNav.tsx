"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { SidebarNav, SidebarTrigger } from "@/components/ui/intent/sidebar";
import { useT } from "@/lib/i18n/I18nProvider";
import { PageSearch, type PageSearchConfig } from "@/components/admin/PageSearch";

// Top nav bar for the admin inset: sidebar toggle + breadcrumbs derived from
// the current pathname. Kept dependency-light; no hardcoded page list.
//
// 麵包屑是自己的 next/link,不是 Intent 的 Breadcrumbs —— 後者底下是 react-aria 的
// Link,沒有 RouterProvider 就是整頁重載(同 AdminNavLink 的說明)。

interface AdminNavProps {
  menuTitles: Record<string, string>;
  /** 側欄資料夾的 href(= 第一個子頁)→ 資料夾名。當「上一層」時顯示資料夾名。 */
  folderTitles?: Record<string, string>;
  /** 1.40.0:宣告了搜尋的插件頁 → 頂欄右側的搜尋框。 */
  pageSearch?: Record<string, PageSearchConfig>;
}

function labelFor(
  segment: string,
  href: string,
  menuTitles: Record<string, string>,
): string {
  if (menuTitles[href]) return menuTitles[href];
  // Fall back to a humanized segment.
  return segment
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const EXT_ROOT = /^\/admin\/ext\/[^/]+$/;

export function AdminNav({ menuTitles, folderTitles = {}, pageSearch = {} }: AdminNavProps) {
  const pathname = usePathname();
  const t = useT();
  const segments = pathname.split("/").filter(Boolean); // ["admin", ...]

  // /admin/ext 只是 extension 頁的路由前綴,不是一頁:不給它一格「Ext」麵包屑。
  // 上一層是側欄資料夾時顯示資料夾名,不是資料夾第一頁的標題。
  // 沒有標題的插件根路徑(例如訂單頁被別的插件取代後的 /admin/ext/shop)不是側欄上的一頁,
  // 顯示成「Shop」只會讓人以為有這一頁,略過。
  const crumbs = segments
    .map((seg, i) => {
      const href = "/" + segments.slice(0, i + 1).join("/");
      const last = i === segments.length - 1;
      const title = (!last && folderTitles[href]) || menuTitles[href];
      return { href, last, titled: Boolean(title), label: title || labelFor(seg, href, menuTitles) };
    })
    .filter((crumb) => crumb.href !== "/admin/ext")
    .filter((crumb) => crumb.last || crumb.titled || !EXT_ROOT.test(crumb.href));

  return (
    <SidebarNav className="h-14 border-b border-ink/[0.07] bg-background/80 backdrop-blur-md">
      <span className="flex items-center gap-x-3">
        <SidebarTrigger className="-ml-1.5 size-8 rounded-[calc(8px*var(--admin-radius-scale,1))] text-ink/50 transition-[background-color,transform] duration-150 ease-out hover:bg-ink/[0.03] active:scale-[0.96] lg:ml-0" />
        <nav
          aria-label={t("admin.breadcrumb")}
          className="hidden items-center gap-2 text-[13px] md:flex"
        >
          {crumbs.map((c, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <span key={c.href} className="flex items-center gap-2">
                {isLast ? (
                  <span aria-current="page" className="font-medium text-ink/85">
                    {c.label}
                  </span>
                ) : (
                  <Link
                    href={c.href}
                    prefetch={false}
                    className="text-ink/45 transition-colors duration-150 hover:text-ink/80"
                  >
                    {c.label}
                  </Link>
                )}
                {!isLast && (
                  <ChevronRight aria-hidden className="size-3.5 shrink-0 text-ink/25" />
                )}
              </span>
            );
          })}
        </nav>
      </span>
      {pageSearch[pathname] ? (
        <span className="ml-auto flex items-center">
          <PageSearch {...pageSearch[pathname]} />
        </span>
      ) : null}
    </SidebarNav>
  );
}
