"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Boxes, ChevronsUpDown, LogOut, UserRound } from "lucide-react";
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
  SidebarItem,
  SidebarLabel,
  SidebarSectionGroup,
} from "@/components/ui/intent/sidebar";
// persist-keys 而不是 persist:後者拉 zod,而這個元件每一頁 admin 都在。
import { clearAllStoredTranscripts } from "./agent/persist-keys";
import { AdminNavGroup } from "./AdminNavGroup";
import { iconForNavItem, type AdminIcon } from "./adminNavIcons";

// Admin sidebar. Structure/behavior (a11y, mobile drawer, keyboard toggle) come
// from Intent UI's sidebar-01 block (react-aria); the visual language is
// "Paper & Ink" (see docs/admin-design-language.md) and the layout matches the
// signed-off dashboard mock: three collapsible folder groups (Admin / Content /
// Shop), real SVG line icons, and a user chip at the bottom. Groupings are
// derived in AdminShell from the dynamic menu (core vs extension pages), never
// hardcoded per extension.

/** kind: core admin item · extension adminPage (Content) · Shop link. */
export type AdminNavKind = "core" | "extension" | "shop";

export interface AdminNavItem {
  href: string;
  title: string;
  kind: AdminNavKind;
  icon?: string;
}

export interface AdminNavGroupData {
  id: string;
  label: string;
  items: AdminNavItem[];
}

// Alias kept for the shell import name.
export type { AdminNavGroupData as AdminNavGroup };

interface AdminSidebarProps {
  user: SessionUser;
  siteTitle: string;
  /** core.brandLogo:自訂品牌圖;空 = 預設黑底 mark。 */
  brandLogo: string;
  groups: AdminNavGroupData[];
}

/** Split an href into its path and (optional) tab query for active matching. */
function splitHref(href: string): { path: string; tab: string | null } {
  const [path, query] = href.split("?");
  const tab = query ? new URLSearchParams(query).get("tab") : null;
  return { path, tab };
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
// read as a rendering glitch, not a marker). Hover is a whisper. We neutralize
// the Intent UI blue fill via the --sidebar-current-* vars and layer our own
// state classes.
//
// Icons: 16px solid glyphs (see adminNavIcons.tsx for why solid) at the *same*
// opacity as the label — icons lighter than their labels read as two layers
// that never got aligned.
function navItemClasses(active: boolean): string {
  return cn(
    "group/nav relative h-8 rounded-[8px] px-2.5 text-[13px] font-medium",
    "[--sidebar-current-bg:transparent] [--sidebar-current-fg:var(--color-fg)]",
    "transition-[background-color,color,box-shadow,transform] duration-150 ease-out",
    "active:scale-[0.97]",
    // Intent sidebar items default to a 5-column grid (room for badges/menus) and
    // add extra icon/end padding. For our simple icon + label nav, collapse that
    // back to a tight 2-col track so the label sits close to the icon.
    "grid-cols-[16px_minmax(0,1fr)] gap-x-2.5 supports-[grid-template-columns:subgrid]:grid-cols-[16px_minmax(0,1fr)]",
    "[&:has(svg+[data-slot=sidebar-label])_svg:has(+[data-slot=sidebar-label])]:me-0",
    "[&_[data-slot=sidebar-label]]:col-start-auto [&_[data-slot=sidebar-label]]:pe-0",
    "[&_svg]:size-4",
    // The active icon's blue is set *on the svg* in renderItem, not here: Intent's
    // current-state rule targets `svg:not([class*='text-'])` with higher
    // specificity than a plain `[&_svg]:` descendant utility and would win.
    active
      ? cn(
          "bg-white text-black/90",
          "shadow-[0_0_0_1px_rgba(20,18,22,0.055),0_1px_2px_-1px_rgba(20,18,22,0.06),0_3px_10px_-4px_rgba(30,20,50,0.08)]",
          "hover:bg-white",
        )
      : "text-black/55 hover:bg-black/[0.03] hover:text-black/90",
  );
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

  const currentTab = searchParams.get("tab");

  /** Active if path matches; for Shop links the ?tab= must match too. */
  function isActive(item: AdminNavItem): boolean {
    const { path, tab } = splitHref(item.href);
    const pathMatches =
      path === "/admin"
        ? pathname === "/admin"
        : pathname === path || pathname.startsWith(`${path}/`);
    if (!pathMatches) return false;
    if (item.kind === "shop") {
      // "Browse store" is active only with ?tab=browse; "Installed" only without.
      return (currentTab ?? null) === (tab ?? null);
    }
    return true;
  }

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
    const active = isActive(item);
    const Icon: AdminIcon = iconForNavItem(item);
    return (
      <SidebarItem
        key={item.href}
        href={item.href}
        tooltip={item.title}
        isCurrent={active}
        className={navItemClasses(active)}
      >
        {/* Icon colour lives on the svg (see navItemClasses): active = dither blue;
            idle = the label's own 55% so icon and text read as one line, lifting
            together on hover. */}
        <Icon
          className={
            active
              ? "text-[rgb(86,114,228)]"
              : "text-black/55 transition-colors duration-150 group-hover/nav:text-black/90"
          }
        />
        <SidebarLabel className="truncate pe-0 text-[13px]">{item.title}</SidebarLabel>
      </SidebarItem>
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
          {groups.map((group) => (
            <AdminNavGroup key={group.id} label={group.label}>
              {group.items.map(renderItem)}
            </AdminNavGroup>
          ))}
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
                    backgroundImage: "linear-gradient(135deg,#5672e4,#8a6fe0)",
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
