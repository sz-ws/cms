"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { SidebarNav, SidebarTrigger } from "@/components/ui/intent/sidebar";
import { useT } from "@/lib/i18n/I18nProvider";

// Top nav bar for the admin inset: sidebar toggle + breadcrumbs derived from
// the current pathname. Kept dependency-light; no hardcoded page list.
//
// 麵包屑是自己的 next/link,不是 Intent 的 Breadcrumbs —— 後者底下是 react-aria 的
// Link,沒有 RouterProvider 就是整頁重載(同 AdminNavLink 的說明)。

interface AdminNavProps {
  menuTitles: Record<string, string>;
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

export function AdminNav({ menuTitles }: AdminNavProps) {
  const pathname = usePathname();
  const t = useT();
  const segments = pathname.split("/").filter(Boolean); // ["admin", ...]

  const crumbs = segments.map((seg, i) => {
    const href = "/" + segments.slice(0, i + 1).join("/");
    return { href, label: labelFor(seg, href, menuTitles) };
  });

  return (
    <SidebarNav className="h-14 border-b border-black/[0.07] bg-[#fbfaf9]/80 backdrop-blur-md">
      <span className="flex items-center gap-x-3">
        <SidebarTrigger className="-ml-1.5 size-8 rounded-[8px] text-black/50 transition-[background-color,transform] duration-150 ease-out hover:bg-black/[0.03] active:scale-[0.96] lg:ml-0" />
        <nav
          aria-label={t("admin.breadcrumb")}
          className="hidden items-center gap-2 text-[13px] md:flex"
        >
          {crumbs.map((c, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <span key={c.href} className="flex items-center gap-2">
                {isLast ? (
                  <span aria-current="page" className="font-medium text-black/85">
                    {c.label}
                  </span>
                ) : (
                  <Link
                    href={c.href}
                    prefetch={false}
                    className="text-black/45 transition-colors duration-150 hover:text-black/80"
                  >
                    {c.label}
                  </Link>
                )}
                {!isLast && (
                  <ChevronRight aria-hidden className="size-3.5 shrink-0 text-black/25" />
                )}
              </span>
            );
          })}
        </nav>
      </span>
    </SidebarNav>
  );
}
