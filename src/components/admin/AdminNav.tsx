"use client";

import { usePathname } from "next/navigation";
import {
  Breadcrumbs,
  BreadcrumbsItem,
} from "@/components/ui/intent/breadcrumbs";
import { SidebarNav, SidebarTrigger } from "@/components/ui/intent/sidebar";

// Top nav bar for the admin inset: sidebar toggle + breadcrumbs derived from
// the current pathname. Kept dependency-light; no hardcoded page list.

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
  const segments = pathname.split("/").filter(Boolean); // ["admin", ...]

  const crumbs = segments.map((seg, i) => {
    const href = "/" + segments.slice(0, i + 1).join("/");
    return { href, label: labelFor(seg, href, menuTitles) };
  });

  return (
    <SidebarNav className="h-14 border-b border-black/[0.07] bg-[#fbfaf9]/80 backdrop-blur-md">
      <span className="flex items-center gap-x-3">
        <SidebarTrigger className="-ml-1.5 size-8 rounded-[8px] text-black/50 transition-[background-color,transform] duration-150 ease-out hover:bg-black/[0.03] active:scale-[0.96] lg:ml-0" />
        <Breadcrumbs className="hidden text-[13px] md:flex **:data-[slot=breadcrumb-item]:text-black/45 **:[a]:transition-colors **:[a]:duration-150 hover:**:[a]:text-black/80">
          {crumbs.map((c, i) => {
            const isLast = i === crumbs.length - 1;
            // The current (last) crumb must NOT receive an href prop at all —
            // passing `href={undefined}` still counts as an own property and
            // react-aria coerces it to href="" (the empty-href warning). Spread
            // the href only for linkable ancestor crumbs.
            return (
              <BreadcrumbsItem
                key={c.href}
                {...(isLast ? {} : { href: c.href })}
                className={isLast ? "font-medium text-black/85" : undefined}
              >
                {c.label}
              </BreadcrumbsItem>
            );
          })}
        </Breadcrumbs>
      </span>
    </SidebarNav>
  );
}
