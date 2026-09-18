import {
  safeAdminIcon,
  type AdminMenuItem,
  type AdminNavSection,
} from "@/ext/admin-menu";

// 側欄的「選單項目 → 分區群組」規則。純函式,AdminShell(server)用它把 layout 給的
// menu 與分區切成群組,再交給 client 的 AdminSidebar 渲染;測試也直接打這裡。

/** kind: core admin item · extension adminPage · Shop link. */
export type AdminNavKind = "core" | "extension" | "shop";

export interface AdminNavItem {
  href: string;
  title: string;
  kind: AdminNavKind;
  /** Icon token or inline `<svg>` (already svg-guarded here). */
  icon?: string;
  /** 1.39.0: one level of nesting. A folder's href is its first child's. */
  children?: AdminNavItem[];
}

export interface AdminNavGroupData {
  id: string;
  label: string;
  items: AdminNavItem[];
  /** 1.40.0:見 AdminNavSection.collapse。 */
  collapse?: AdminNavSection["collapse"];
}

/** Extension admin pages are routed under /admin/ext/*; everything else is core. */
function isExtensionHref(href: string): boolean {
  return href.startsWith("/admin/ext/") || href === "/admin/ext";
}

/** The extensions manager (reframed as the "Shop") lives at /admin/extensions. */
function isShopHref(href: string): boolean {
  return href === "/admin/extensions" || href.startsWith("/admin/extensions/");
}

/** 系統管理面(人與站台設定)—— sidebar 底部自成一組,和日常工作區分開。 */
function isSystemHref(href: string): boolean {
  return href === "/admin/users" || href === "/admin/settings";
}

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

/**
 * 項目歸哪一區:明確的 `section` 優先(manifest 或 filter:adminMenu 給的);沒給的依
 * 路由判斷 —— Users / Settings → system,extension 頁或資料夾 → content,其餘 core
 * 項 → workspace。
 */
function sectionOf(item: AdminMenuItem, nav: AdminNavItem): string {
  if (item.section) return item.section;
  if (isSystemHref(item.href)) return "system";
  if (nav.kind === "extension" || nav.children) return "content";
  return "workspace";
}

function systemRank(href: string): number {
  if (href === "/admin/users") return 0;
  if (href === "/admin/settings") return 2;
  return 1;
}

/**
 * Split the menu into sidebar groups, one per section, in section order. Empty
 * sections are dropped. The extensions manager is absorbed into the "shop"
 * section as "Browse" + "Installed". An item pointing at a section that does not
 * exist lands in "content" (or the first section, if a site removed that too),
 * so a stale `section` never makes a page unreachable from the sidebar.
 */
export function buildAdminNavGroups(
  menu: readonly AdminMenuItem[],
  sections: readonly AdminNavSection[],
  shopLabels: { browse: string; installed: string },
): AdminNavGroupData[] {
  if (sections.length === 0) return [];
  const known = new Set(sections.map((section) => section.id));
  const fallback = known.has("content") ? "content" : sections[0].id;
  const resolve = (id: string) => (known.has(id) ? id : fallback);

  const buckets = new Map<string, AdminNavItem[]>();
  const put = (id: string, item: AdminNavItem) => {
    const key = resolve(id);
    buckets.set(key, [...(buckets.get(key) ?? []), item]);
  };

  let hasShop = false;
  for (const item of menu) {
    if (isShopHref(item.href)) {
      hasShop = true; // absorbed into the synthetic Shop items below
      continue;
    }
    // Account 是「個人」不是「站台」:住在底部使用者晶片的選單(AdminSidebar
    // footer),不佔 nav 群組;menu 仍保留它供 breadcrumb 標題查表。
    if (item.href === "/admin/account") continue;
    const nav = toNavItem(item);
    put(sectionOf(item, nav), nav);
  }

  if (hasShop) {
    put("shop", {
      href: "/admin/extensions?tab=browse",
      title: shopLabels.browse,
      kind: "shop",
    });
    put("shop", { href: "/admin/extensions", title: shopLabels.installed, kind: "shop" });
  }

  // Users 在前、extension 的系統項居中、Settings 恆為最後一項(最深的設定錨點
  // 放最底,慣例)。sort 是 stable,同 rank 維持 menu 順序。
  const system = buckets.get("system");
  if (system) {
    buckets.set(
      "system",
      [...system].sort((a, b) => systemRank(a.href) - systemRank(b.href)),
    );
  }

  return sections
    .filter((section) => (buckets.get(section.id)?.length ?? 0) > 0)
    .map((section) => ({
      id: section.id,
      label: section.label,
      items: buckets.get(section.id) ?? [],
      ...(section.collapse ? { collapse: section.collapse } : {}),
    }));
}
