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
import { safeAdminIcon, type AdminMenuItem } from "@/ext/admin-menu";

// 05 §1: fixed CMS shell = left sidebar + top nav + content. Built on Intent
// UI's sidebar-01 block (react-aria). Server component: receives the dynamic
// admin menu from layout.tsx, derives the sidebar folder groups
// (Workspace / Content / Commerce / Shop / System), and hands them to the client sidebar/nav.

// 型別搬到 ext/admin-menu.ts(1.39.0,與選單建構規則住一起);這裡保留舊的匯入名。
export type { AdminMenuItem };

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
    commerce: string;
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
 * Split the menu into the sidebar's folder groups. Grouping is derived from the
 * route kind and the item's declared `section`, never from extension names:
 *
 * - Workspace → core items (Dashboard, Assistant, Media).
 * - Content   → extension pages without a section (or section "content").
 * - Commerce  → items declaring section "commerce" (1.39.0).
 * - Shop      → the extensions manager, reframed as "Browse" + "Installed",
 *               rendered only when the manager is reachable (admin).
 * - System    → Users, extension items declaring section "system", Settings last.
 *
 * Items with `children` stay nested (one level); inline-SVG icons that fail
 * svg-guard are dropped here, on the server, before reaching the client.
 */
function toNavItem(item: AdminMenuItem): AdminNavItem {
  const kind = isExtensionHref(item.href) ? "extension" : "core";
  return {
    href: item.href,
    title: item.title,
    icon: safeAdminIcon(item.icon),
    kind,
    ...(item.children?.length
      ? {
          children: item.children.map((child) => ({
            href: child.href,
            title: child.title,
            kind: isExtensionHref(child.href) ? "extension" : "core",
          })),
        }
      : {}),
  };
}

function systemRank(href: string): number {
  if (href === "/admin/users") return 0;
  if (href === "/admin/settings") return 2;
  return 1;
}

function buildGroups(
  menu: AdminMenuItem[],
  labels: AdminShellProps["navLabels"],
): AdminNavGroup[] {
  const coreItems: AdminNavItem[] = [];
  const contentItems: AdminNavItem[] = [];
  const commerceItems: AdminNavItem[] = [];
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
    const nav = toNavItem(item);
    if (item.section === "commerce") commerceItems.push(nav);
    else if (item.section === "system" || isSystemHref(item.href)) systemItems.push(nav);
    else if (item.section === "content" || nav.kind === "extension" || nav.children) {
      contentItems.push(nav);
    } else coreItems.push(nav);
  }

  // 順序敘事:日常工作(Workspace)→ 內容 → 商務 → 擴充(Shop)→ 系統(System)。
  const groups: AdminNavGroup[] = [
    { id: "workspace", label: labels.workspace, items: coreItems },
  ];

  if (contentItems.length > 0) {
    groups.push({ id: "content", label: labels.content, items: contentItems });
  }

  if (commerceItems.length > 0) {
    groups.push({ id: "commerce", label: labels.commerce, items: commerceItems });
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
    // Users 在前、extension 的系統項居中、Settings 恆為最後一項(最深的設定錨點
    // 放最底,慣例)。sort 是 stable,同 rank 維持 menu 順序。
    systemItems.sort((a, b) => systemRank(a.href) - systemRank(b.href));
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
  // 資料夾的 href 指向第一個子項:先寫資料夾、再寫子項,麵包屑顯示的是頁面標題。
  for (const item of menu) {
    menuTitles[item.href] = item.title;
    for (const child of item.children ?? []) menuTitles[child.href] = child.title;
  }

  // Extension ids that have admin surfaces — pass them to the client-side
  // layout loader so it can try a fixed-entry `extensions/<id>/layout.tsx`
  // for each. Missing files fall back to the generic FormView baseline.
  const layoutExtIds = Array.from(
    new Set(
      menu
        .flatMap((m) => [m, ...(m.children ?? [])])
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
