import type { CSSProperties, ReactNode } from "react";
import type { SessionUser } from "@/lib/auth";
import { SidebarInset, SidebarProvider } from "@/components/ui/intent/sidebar";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { AdminNav } from "@/components/admin/AdminNav";
import { AdminTitlesProvider } from "@/components/admin/admin-titles";
import { SearchPalette } from "@/components/admin/SearchPalette";
import { buildAdminNavGroups } from "@/components/admin/nav-groups";
import { ExtensionLayoutLoader } from "@/ext/dx/extension-layouts";
import type { AdminMenuItem, AdminNavSection } from "@/ext/admin-menu";

// 05 §1: fixed CMS shell = left sidebar + top nav + content. Built on Intent
// UI's sidebar-01 block (react-aria). Server component: receives the dynamic
// admin menu and the sidebar sections from layout.tsx, splits the menu into one
// group per section (rules in nav-groups.ts), and hands them to the client sidebar/nav.

// 型別搬到 ext/admin-menu.ts(1.39.0,與選單建構規則住一起);這裡保留舊的匯入名。
export type { AdminMenuItem };

interface AdminShellProps {
  user: SessionUser;
  menu: AdminMenuItem[];
  siteTitle: string;
  /** core.brandLogo:空字串 = 用預設黑底 mark。 */
  brandLogo: string;
  children: ReactNode;
  /** 1.40.0:側欄分區(預設五區,經 filter:adminSections),已排序。 */
  sections: AdminNavSection[];
  /** 擴充功能管理在側欄的兩個入口。 */
  shopLabels: { browse: string; installed: string };
  /** Breadcrumb titles for core sub-pages that are not sidebar items (href → title). */
  crumbTitles?: Record<string, string>;
}

export function AdminShell({
  user,
  menu,
  siteTitle,
  brandLogo,
  children,
  sections,
  shopLabels,
  crumbTitles,
}: AdminShellProps) {
  const groups = buildAdminNavGroups(menu, sections, shopLabels);

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
        <main className="flex-1 p-4 lg:p-6">
          {/* 頁面標題跟側欄同名(站台改名後也一致),見 admin-titles.tsx。 */}
          <AdminTitlesProvider titles={menuTitles}>{children}</AdminTitlesProvider>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
