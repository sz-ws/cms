"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Boxes, ChevronRight, ChevronsUpDown, LogOut, UserRound } from "lucide-react";
import type { SessionUser } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import {
  Menu,
  MenuContent,
  MenuHeader,
  MenuItem,
  MenuLabel,
  MenuSection,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/intent/menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarLabel,
  SidebarSectionGroup,
  useSidebar,
} from "@/components/ui/intent/sidebar";
// persist-keys 而不是 persist:後者拉 zod,而這個元件每一頁 admin 都在。
import { clearAllStoredTranscripts } from "./agent/persist-keys";
import { AdminNavGroup } from "./AdminNavGroup";
import { AdminNavLink } from "./AdminNavLink";
import { NavIcon } from "./adminNavIcons";
import { pickActiveHref } from "./nav-active";
import type { AdminNavGroupData, AdminNavItem, AdminNavKind } from "./nav-groups";

// Admin sidebar. Structure/behavior (a11y, mobile drawer, keyboard toggle) come
// from Intent UI's sidebar-01 block (react-aria); the visual language is
// "Paper & Ink" (see docs/admin-design-language.md) and the layout matches the
// signed-off dashboard mock: collapsible folder groups, real SVG line icons, and
// a user chip at the bottom. Groups are the sidebar sections (1.40.0: sites can
// rename, add and fold them via filter:adminSections); AdminShell splits the
// dynamic menu into them (nav-groups.ts), never hardcoded per extension.

// 型別住在 nav-groups.ts(server 端切群組的規則在那裡);這裡保留舊的匯入名。
export type { AdminNavKind, AdminNavItem, AdminNavGroupData };
export type { AdminNavGroupData as AdminNavGroup };

interface AdminSidebarProps {
  user: SessionUser;
  siteTitle: string;
  /** core.brandLogo:自訂品牌圖;空 = 預設黑底 mark。 */
  brandLogo: string;
  groups: AdminNavGroupData[];
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Paper & Ink nav item: 8px radius, 13px medium, text-black/55 idle →
// text-black/90 + white surface + shadow-ring when active; the icon turns
// dither-blue and that is the whole "active" mark (the mock's 2px edge bar was
// dropped: on a rounded white card it sat half outside the corner radius and
// read as a rendering glitch, not a marker). Hover is a whisper.
//
// The row is our own anchor (AdminNavLink), not Intent's SidebarItem — see that
// file for why — so the classes here own the whole layout, no subgrid fighting.
//
// Icons: 16px solid glyphs (see adminNavIcons.tsx for why solid) at the *same*
// opacity as the label — icons lighter than their labels read as two layers
// that never got aligned.
function navItemClasses(active: boolean): string {
  return cn(
    "group/nav relative h-8 rounded-[8px] px-2.5 text-[13px] font-medium",
    "flex items-center gap-x-2.5",
    "transition-[background-color,color,box-shadow,transform] duration-150 ease-out",
    "active:scale-[0.97]",
    "[&_svg]:size-4 [&_svg]:shrink-0",
    active
      ? cn(
          "bg-white text-black/90",
          "shadow-[0_0_0_1px_rgba(20,18,22,0.055),0_1px_2px_-1px_rgba(20,18,22,0.06),0_3px_10px_-4px_rgba(30,20,50,0.08)]",
          "hover:bg-white",
        )
      : "text-black/55 hover:bg-black/[0.03] hover:text-black/90",
  );
}

// Same colour contract as navItemClasses: active icon = dither blue on the svg,
// idle = the label's 55%, lifting with the row on hover.
function iconClasses(active: boolean): string {
  return active
    ? "text-(--admin-accent)"
    : "text-black/55 transition-colors duration-150 group-hover/nav:text-black/90";
}

// A child row inside a folder: no icon column, label indented to sit under the
// parent's label (10px padding + 16px icon + 10px gap = 36px), one step shorter
// than a top-level row so the hierarchy reads without a guide line.
function childItemClasses(active: boolean): string {
  return cn(navItemClasses(active), "h-7 ps-9");
}


export function AdminSidebar({
  user,
  siteTitle,
  brandLogo,
  groups,
}: AdminSidebarProps) {
  const pathname = usePathname();
  const t = useT();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const { state, isMobile } = useSidebar();
  const docked = state === "collapsed" && !isMobile;
  const folderIdBase = useId();
  // Folders open when they hold the current page; a click overrides that until
  // the next full load. Keyed by folder href (its first child, stable per menu).
  const [folderOverrides, setFolderOverrides] = useState<Record<string, boolean>>({});
  // 1.40.0:分區同一套規則。"open" 的分區預設展開;"active" 的只有目前頁面所在
  // 那一區展開。點分區標題的覆寫記在這裡,以分區 id 為 key。
  const [groupOverrides, setGroupOverrides] = useState<Record<string, boolean>>({});
  // 有任何一區平常收合,分區標題就是主要導覽層 —— 全部用同一種標題樣式,不然常駐
  // 展開的那一區會比其他區小一號。
  const accordion = groups.some((group) => group.collapse === "active");

  // One active leaf for the whole sidebar — the longest matching path — so an
  // extension's main page (/admin/ext/shop) does not light up alongside its
  // sub-page (/admin/ext/shop/verify). See nav-active.ts.
  const resolvedHref = pickActiveHref(
    groups.flatMap((group) => group.items),
    pathname,
    searchParams.get("tab"),
  );

  // 點下去到新頁畫好之間有幾百毫秒(dynamic 頁,冷啟動時更久)。pathname 在導覽
  // 結束前不會變,所以側欄若只看 pathname,那段時間整個介面像是沒收到點擊。
  // 先把點到的那一列標成選中,導覽落地就交還給真實路徑。
  //
  // 記下「在哪個網址按的」而不是用 effect 清掉:網址一換,這筆就自動失效 ——
  // 沒有 effect、沒有連鎖 render,也不會有清不掉的殘留高亮。
  const routeKey = `${pathname}?${searchParams.toString()}`;
  const [pending, setPending] = useState<{ href: string; from: string } | null>(
    null,
  );
  const activeHref =
    pending && pending.from === routeKey ? pending.href : resolvedHref;
  const markPending = (href: string) => setPending({ href, from: routeKey });

  async function onLogout() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      // AI 助理的對話存在 localStorage(components/admin/agent/persist.ts)。
      // 登出是使用者明確表示「我離開這台機器了」的那個動作,所以清掉掛在這裡 ——
      // 而不是掛在登入頁掛載時:看到登入頁只代表 session 沒了(逾時、cookie 過期
      // 都算),把它當成「清掉本機資料」的訊號會過度反應,而且會把整個 persist
      // 模組(含 zod)拉進登入頁的 bundle。
      // 換人登入撿到別人對話的那條路不靠這裡,靠 key 綁 user id。
      clearAllStoredTranscripts();
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  }

  function renderItem(item: AdminNavItem) {
    if (item.children?.length) return renderFolder(item, item.children);
    const active = item.href === activeHref;
    return (
      <AdminNavLink
        key={item.href}
        href={item.href}
        active={active}
        tooltip={item.title}
        className={navItemClasses(active)}
        onNavigateStart={markPending}
      >
        {/* Icon colour lives on the svg (see navItemClasses): active = dither blue;
            idle = the label's own 55% so icon and text read as one line, lifting
            together on hover. */}
        <NavIcon item={item} className={iconClasses(active)} />
        {!docked && <span className="min-w-0 flex-1 truncate">{item.title}</span>}
      </AdminNavLink>
    );
  }

  function renderFolder(item: AdminNavItem, children: AdminNavItem[]) {
    const holdsActive = children.some((child) => child.href === activeHref);

    // Icon-only rail: there is no room to expand, so the folder is a link to its
    // first page with the folder name as tooltip.
    if (docked) {
      return (
        <AdminNavLink
          key={`folder:${item.href}`}
          href={children[0].href}
          active={holdsActive}
          tooltip={item.title}
          className={navItemClasses(holdsActive)}
          onNavigateStart={markPending}
        >
          <NavIcon item={item} className={iconClasses(holdsActive)} />
        </AdminNavLink>
      );
    }

    const open = folderOverrides[item.href] ?? holdsActive;
    const panelId = `${folderIdBase}-${item.href}`;
    // Collapsed with the current page inside: the folder row carries the white
    // chip so the sidebar still says where you are. Open: the child row does.
    const chip = holdsActive && !open;
    return (
      <div key={`folder:${item.href}`} data-slot="admin-nav-folder" className="flex flex-col gap-y-0.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() =>
            setFolderOverrides((prev) => ({ ...prev, [item.href]: !open }))
          }
          className={cn(
            navItemClasses(chip),
            "flex w-full items-center gap-x-2.5 text-start outline-hidden focus-visible:inset-ring focus-visible:inset-ring-sidebar-ring",
          )}
        >
          <NavIcon item={item} className={iconClasses(holdsActive)} />
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-black/30 transition-transform duration-150 ease-out",
              open && "rotate-90",
            )}
          />
        </button>
        <div id={panelId} hidden={!open} className="flex flex-col gap-y-0.5">
          {children.map((child) => {
            const active = child.href === activeHref;
            return (
              <AdminNavLink
                key={child.href}
                href={child.href}
                active={active}
                className={childItemClasses(active)}
                onNavigateStart={markPending}
              >
                <span className="min-w-0 flex-1 truncate">{child.title}</span>
              </AdminNavLink>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <Sidebar collapsible="dock" className="bg-[#fbfaf9]">
      <SidebarHeader>
        <div className="flex items-center gap-x-2.5 px-1 py-0.5">
          {/* 自訂品牌(core.brandLogo);空值退回預設黑底 mark。 */}
          {brandLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={brandLogo}
              alt=""
              aria-hidden
              className="size-7 shrink-0 rounded-[8px] object-cover shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.12)]"
            />
          ) : (
            <span
              aria-hidden
              className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-black text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)]"
            >
              <Boxes className="size-[15px]" />
            </span>
          )}
          <SidebarLabel className="truncate text-[14px] font-semibold tracking-[-0.01em] text-black/90">
            {siteTitle}
          </SidebarLabel>
        </div>
      </SidebarHeader>

      <SidebarContent className="px-1.5">
        <SidebarSectionGroup className="gap-y-0">
          {groups.map((group) => {
            const holdsActive = group.items.some(
              (item) =>
                item.href === activeHref ||
                (item.children ?? []).some((child) => child.href === activeHref),
            );
            const open =
              groupOverrides[group.id] ??
              (group.collapse === "active" ? holdsActive : true);
            return (
              <AdminNavGroup
                key={group.id}
                label={group.label}
                // Icon rail has no group headers to click, so every group shows.
                open={docked || open}
                onToggle={() =>
                  setGroupOverrides((prev) => ({ ...prev, [group.id]: !open }))
                }
                prominent={accordion}
                holdsActive={holdsActive}
              >
                {group.items.map(renderItem)}
              </AdminNavGroup>
            );
          })}
        </SidebarSectionGroup>
      </SidebarContent>

      <SidebarFooter className="p-1.5">
        <Menu>
          <MenuTrigger
            className={cn(
              "flex w-full items-center justify-between rounded-[10px] p-1.5 text-left",
              "bg-white shadow-[0_0_0_1px_rgba(20,18,22,0.055),0_1px_2px_-1px_rgba(20,18,22,0.06),0_3px_10px_-4px_rgba(30,20,50,0.08)]",
              "transition-[background-color,transform] duration-150 ease-out",
              "hover:shadow-[0_0_0_1px_rgba(20,18,22,0.06),0_2px_4px_-2px_rgba(20,18,22,0.06),0_16px_34px_-14px_rgba(30,20,50,0.20)] active:scale-[0.98]",
              "in-data-[collapsible=dock]:bg-transparent in-data-[collapsible=dock]:shadow-none",
            )}
            aria-label="Account menu"
          >
            <div className="flex min-w-0 items-center gap-x-2.5">
              {/* 頭像 chip:有上傳用圖(51a329f),否則退回 brand-gradient 縮寫。 */}
              {user.avatarKey ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/files/${user.avatarKey}`}
                  alt=""
                  aria-hidden
                  className="size-7 shrink-0 rounded-[8px] object-cover shadow-[0_0_0_1px_rgba(0,0,0,0.08)]"
                />
              ) : (
                <span
                  aria-hidden
                  style={{
                    backgroundImage: "linear-gradient(135deg,var(--admin-accent),color-mix(in srgb,var(--admin-accent) 60%,white))",
                  }}
                  className="flex size-7 shrink-0 items-center justify-center rounded-[8px] text-[12px] font-semibold text-white"
                >
                  {initialsOf(user.name)}
                </span>
              )}
              <div className="min-w-0 text-start in-data-[collapsible=dock]:hidden">
                <div className="truncate text-[12.5px] font-semibold leading-tight text-black/90">
                  {user.name}
                </div>
                <div className="truncate text-[11px] text-black/40">
                  {user.role}
                </div>
              </div>
            </div>
            <ChevronsUpDown
              data-slot="chevron"
              className="size-4 shrink-0 text-black/30 in-data-[collapsible=dock]:hidden"
            />
          </MenuTrigger>
          <MenuContent
            className="min-w-(--trigger-width) in-data-[sidebar-collapsible=collapsed]:min-w-56"
            placement="top right"
          >
            <MenuSection>
              <MenuHeader separator>
                <span className="block truncate text-[13px] font-medium text-black/85">
                  {user.name}
                </span>
                <span className="block truncate text-[11.5px] font-normal text-black/40">
                  {/* placeholder email(OAuth 帳號拿不到 email)遮罩;role 走 i18n。 */}
                  {isPlaceholderEmail(user.email)
                    ? t("account.noEmail")
                    : user.email}
                  {" · "}
                  {user.role === "admin"
                    ? t("account.roleAdmin")
                    : user.role === "guest"
                      ? t("account.roleGuest")
                      : t("account.roleEditor")}
                </span>
              </MenuHeader>
            </MenuSection>
            {/* 個人層級的入口住這裡;站台 Settings 在 sidebar 的 System 群組。 */}
            <MenuItem href="/admin/account" className="text-[13px]">
              <UserRound />
              <MenuLabel>{t("sidebar.account")}</MenuLabel>
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              isDisabled={signingOut}
              onAction={onLogout}
              className="text-[13px]"
            >
              <LogOut />
              <MenuLabel>{signingOut ? t("sidebar.signingOut") : t("sidebar.logOut")}</MenuLabel>
            </MenuItem>
          </MenuContent>
        </Menu>
      </SidebarFooter>
    </Sidebar>
  );
}
