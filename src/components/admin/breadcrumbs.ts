// 後台頂欄的麵包屑:從網址一段一段長出來,標題查側欄(AdminShell 給的 href → 標題)。
// 純函式,AdminNav 用、測試直接打。

export interface Breadcrumb {
  href: string;
  label: string;
}

export interface BreadcrumbTitles {
  menuTitles: Record<string, string>;
  /** 側欄資料夾的 href(= 第一個子頁)→ 資料夾名。當「上一層」時顯示資料夾名。 */
  folderTitles?: Record<string, string>;
  /** 側欄頁的 href → 分區 id(nav-groups.ts sectionsByHref)。 */
  hrefSections?: Record<string, string>;
}

const ADMIN_ROOT = "/admin";
const EXT_ROOT = /^\/admin\/ext\/[^/]+$/;

function humanize(segment: string): string {
  return segment.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * - /admin/ext 只是 extension 頁的路由前綴,不是一頁:不給它一格「Ext」。
 * - 上一層是側欄資料夾時顯示資料夾名,不是資料夾第一頁的標題。
 * - 沒有標題的插件根路徑(例如訂單頁被別的插件取代後的 /admin/ext/shop)不是側欄上的
 *   一頁,顯示成「Shop」只會讓人以為有這一頁,略過。
 * - 側欄經過 filter:adminMenu 之後,上一層可能在別的分區(例如 /admin/ext/partner/stock
 *   被站台移到「電商」,/admin/ext/partner 還在「夥伴」):那一格略過,麵包屑跟著店家
 *   看到的側欄走。儀表板(/admin)是起點,永遠保留。
 */
export function buildBreadcrumbs(pathname: string, titles: BreadcrumbTitles): Breadcrumb[] {
  const { menuTitles, folderTitles = {}, hrefSections = {} } = titles;
  const segments = pathname.split("/").filter(Boolean); // ["admin", ...]
  const crumbs = segments
    .map((seg, i) => {
      const href = "/" + segments.slice(0, i + 1).join("/");
      const last = i === segments.length - 1;
      const title = (!last && folderTitles[href]) || menuTitles[href];
      return { href, last, titled: Boolean(title), label: title || humanize(seg) };
    })
    .filter((crumb) => crumb.href !== "/admin/ext")
    .filter((crumb) => crumb.last || crumb.titled || !EXT_ROOT.test(crumb.href));

  // 目前這頁所在的分區:最深、在側欄上的那一格(編輯頁這類不在側欄的,看它的上一層)。
  // 起點不算:只有儀表板對得上時,不知道這頁在哪一區,就一格都不略。
  const current = [...crumbs]
    .reverse()
    .find((crumb) => crumb.href !== ADMIN_ROOT && hrefSections[crumb.href]);
  const section = current ? hrefSections[current.href] : undefined;
  return crumbs
    .filter(
      (crumb) =>
        crumb.last ||
        crumb.href === ADMIN_ROOT ||
        !section ||
        !hrefSections[crumb.href] ||
        hrefSections[crumb.href] === section,
    )
    .map(({ href, label }) => ({ href, label }));
}
