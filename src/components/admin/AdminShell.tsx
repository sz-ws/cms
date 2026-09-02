import type { CSSProperties, ReactNode } from "react";
import type { SessionUser } from "@/lib/auth";
import { SidebarInset, SidebarProvider } from "@/components/ui/intent/sidebar";
import {
  AdminSidebar,
  type AdminNavGroup,
  type AdminNavItem,
} from "@/components/admin/AdminSidebar";
import { AdminNav } from "@/components/admin/AdminNav";
import { SearchPalette } from "@/components/admin/SearchPalette";
import { ExtensionLayoutLoader } from "@/ext/dx/extension-layouts";

// 05 §1: fixed CMS shell = left sidebar + top nav + content. Built on Intent
// UI's sidebar-01 block (react-aria). Server component: receives the dynamic
// admin menu from layout.tsx, derives the three sidebar folder groups
// (Admin / Content / Shop), and hands them to the client sidebar/nav.

export interface AdminMenuItem {
  href: string;
  title: string;
  order?: number;
  /** extension/core/shop icon hint (lucide token string). */
  icon?: string;
}

interface AdminShellProps {
  user: SessionUser;
  menu: AdminMenuItem[];
  siteTitle: string;
  /** core.brandLogo:空字串 = 用預設黑底 mark。 */
  brandLogo: string;
  children: ReactNode;
  navLabels: {
    workspace: string;
    content: string;
    shop: string;
    browse: string;
    installed: string;
    system: string;
  };
  /** Breadcrumb titles for core sub-pages that are not sidebar items (href → title). */
  crumbTitles?: Record<string, string>;
}

/** Extension admin pages are routed under /admin/ext/*; everything else is core. */
function isExtensionHref(href: string): boolean {
  return href.startsWith("/admin/ext/") || href === "/admin/ext";
}

/** The extensions manager (reframed as the "Shop") lives at /admin/extensions. */
function isShopHref(href: string): boolean {
  return (
    href === "/admin/extensions" || href.startsWith("/admin/extensions/")
  );
}

/** 系統管理面(人與站台設定)—— sidebar 底部自成一組,和日常工作區分開。 */
function isSystemHref(href: string): boolean {
  return href === "/admin/users" || href === "/admin/settings";
}

/**
 * Split the flat menu into the three collapsible folder groups the mock shows.
 * Grouping is derived by *kind* of route, never by hardcoded extension names:
 *
 * - Admin   → core items (Dashboard, Media, Settings, Users) — everything that
 *             is neither an extension page nor the Shop.
 * - Content → extension adminPages under /admin/ext/* (the content-type
 *             extensions: Gallery, Blog, Pages…), each appearing once.
 * - Shop    → the old "Extensions" manager, reframed: a synthetic pair of
 *             "Browse store" (registry Browse tab) + "Installed" (management),
 *             both pointing at the real /admin/extensions route. Rendered only
 *             when the manager is reachable in this session (admin).
 */
function buildGroups(
  menu: AdminMenuItem[],
  labels: AdminShellProps["navLabels"],
): AdminNavGroup[] {
  const coreItems: AdminNavItem[] = [];
  const contentItems: AdminNavItem[] = [];
  const systemItems: AdminNavItem[] = [];
  let hasShop = false;

  for (const item of menu) {
    if (isShopHref(item.href)) {
      hasShop = true; // absorbed into the synthetic Shop group below
      continue;
    }
    // Account 是「個人」不是「站台」:住在底部使用者晶片的選單(AdminSidebar
    // footer),不佔 nav 群組;menu 仍保留它供 breadcrumb 標題查表。
    if (item.href === "/admin/account") continue;
    const nav: AdminNavItem = {
      href: item.href,
      title: item.title,
      icon: item.icon,
      kind: isExtensionHref(item.href) ? "extension" : "core",
    };
    if (nav.kind === "extension") contentItems.push(nav);
    else if (isSystemHref(item.href)) systemItems.push(nav);
    else coreItems.push(nav);
  }

  // 順序敘事:日常工作(Workspace)→ 內容(Content)→ 擴充(Shop)→ 系統(System)。
  const groups: AdminNavGroup[] = [
    { id: "workspace", label: labels.workspace, items: coreItems },
  ];

  if (contentItems.length > 0) {
    groups.push({ id: "content", label: labels.content, items: contentItems });
  }

  if (hasShop) {
    groups.push({
      id: "shop",
      label: labels.shop,
      items: [
        {
          href: "/admin/extensions?tab=browse",
          title: labels.browse,
          kind: "shop",
        },
        { href: "/admin/extensions", title: labels.installed, kind: "shop" },
      ],
    });
  }

  if (systemItems.length > 0) {
    // Users 在前、Settings 恆為最後一項(最深的設定錨點放最底,慣例)。
    systemItems.sort((a, b) =>
      a.href === "/admin/settings" ? 1 : b.href === "/admin/settings" ? -1 : 0,
    );
    groups.push({ id: "system", label: labels.system, items: systemItems });
  }

  return groups;
}

export function AdminShell({
  user,
  menu,
  siteTitle,
  brandLogo,
  children,
  navLabels,
  crumbTitles,
}: AdminShellProps) {
  const groups = buildGroups(menu, navLabels);

  // Href → title map for breadcrumb labeling. Menu items first; `crumbTitles`
  // covers core sub-pages that are reachable but deliberately not in the
  // sidebar (e.g. /admin/agent/audit), so their crumb reads the page title
  // instead of a capitalised path segment.
  const menuTitles: Record<string, string> = { ...crumbTitles };
  for (const item of menu) menuTitles[item.href] = item.title;

  // Extension ids that have admin surfaces — pass them to the client-side
  // layout loader so it can try a fixed-entry `extensions/<id>/layout.tsx`
  // for each. Missing files fall back to the generic FormView baseline.
  const layoutExtIds = Array.from(
    new Set(
      menu
        .filter((m) => m.href.startsWith("/admin/ext/"))
        .map((m) => m.href.split("/")[3])
        .filter((x): x is string => Boolean(x)),
    ),
  );

  return (
    <SidebarProvider
      // Trim the Intent UI default (17rem/272px) — it ate too much width.
      style={{ "--sidebar-width": "14rem" } as CSSProperties}
    >
      <ExtensionLayoutLoader extIds={layoutExtIds} />
      {/* ⌘K 全站內容搜尋(常駐 mount;開關由全域快捷鍵驅動)。 */}
      <SearchPalette />
      <AdminSidebar
        user={user}
        siteTitle={siteTitle}
        brandLogo={brandLogo}
        groups={groups}
      />
      <SidebarInset>
        <AdminNav menuTitles={menuTitles} />
        <main className="flex-1 p-4 lg:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
