import { cache } from "react";
import { getExtRuntime } from "@/ext/loader";
import {
  buildExtensionMenu,
  defaultAdminSections,
  normalizeAdminSections,
  type AdminMenuItem,
  type AdminNavSection,
} from "@/ext/admin-menu";
import { deriveAccessSections, type AccessSection } from "@/ext/admin-access";
import {
  buildAdminNavGroups,
  type AdminNavGroupData,
} from "@/components/admin/nav-groups";
import { isAgentAvailable } from "@/lib/ai";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { resolveLocalizedString } from "@/lib/i18n/localized";

// 後台側欄的選單與分區(原本寫在 admin/layout.tsx)。1.50.0 起角色與權限頁的矩陣、
// 自訂角色的登入落點也要同一份選單,所以搬到這裡共用 —— 矩陣的列永遠與側欄一致。

export interface AdminMenuOptions {
  /** AI 助理入口(只給管理者,而且 AI 設定好了才有)。 */
  agent: boolean;
  /** 成員與角色(只給管理者)。 */
  people: boolean;
}

/** 固定項 + 每個啟用中 extension 的後台頁,再過 filter:adminMenu。 */
export async function buildAdminMenu(options: AdminMenuOptions): Promise<AdminMenuItem[]> {
  const rt = await getExtRuntime();
  const locale = await getLocale();
  const messages = getMessages(locale);

  // 1.39.0:extension 可宣告分區與巢狀(menu.section / menu.parent),多頁的收成資料夾
  // —— 規則在 ext/admin-menu.ts。
  const extItems = buildExtensionMenu(
    rt.enabled,
    (value) => resolveLocalizedString(value, locale),
    messages["nav.overview"],
  );

  const menu: AdminMenuItem[] = [
    { href: "/admin", title: messages["nav.dashboard"] },
    // AI 助理(docs/spec-admin-agent.md §1.1):admin-only,不可協商 —— editor/guest
    // 連入口都不渲染。頁面本身另有 requireAuth("admin"),API 端點各自再一道。
    ...(options.agent ? [{ href: "/admin/agent", title: messages["nav.agent"] }] : []),
    { href: "/admin/media", title: messages["nav.media"] },
    ...extItems,
    { href: "/admin/extensions", title: messages["nav.extensions"] },
    { href: "/admin/account", title: messages["nav.account"] },
    { href: "/admin/settings", title: messages["nav.settings"] },
    ...(options.people
      ? [
          { href: "/admin/users", title: messages["nav.users"] },
          { href: "/admin/roles", title: messages["nav.roles"] },
        ]
      : []),
  ];

  // menu 過 filter:adminMenu(extension 可增刪排序 menu 項)。
  return rt.hooks.applyFilters<AdminMenuItem[]>("filter:adminMenu", menu);
}

/** 側欄分區(預設五區,經 filter:adminSections 讓站台改名、加區、排序)。 */
export async function buildAdminSections(): Promise<AdminNavSection[]> {
  const rt = await getExtRuntime();
  const messages = getMessages(await getLocale());
  const builtinSections = defaultAdminSections({
    workspace: messages["nav.group.workspace"],
    content: messages["nav.group.content"],
    commerce: messages["nav.group.commerce"],
    shop: messages["nav.group.shop"],
    system: messages["nav.group.system"],
  });
  return normalizeAdminSections(
    await rt.hooks.applyFilters<AdminNavSection[]>("filter:adminSections", builtinSections),
    builtinSections,
  );
}

export async function shopNavLabels(): Promise<{ browse: string; installed: string }> {
  const messages = getMessages(await getLocale());
  return { browse: messages["nav.browse"], installed: messages["nav.installed"] };
}

/**
 * 管理者看到的完整側欄群組。角色與權限頁的矩陣、自訂角色的登入落點都以它為準。
 * React cache():同一個 request 只建一次。
 */
export const getFullAdminNavGroups = cache(async (): Promise<AdminNavGroupData[]> => {
  const [menu, sections, labels] = await Promise.all([
    buildAdminMenu({ agent: await isAgentAvailable(), people: true }),
    buildAdminSections(),
    shopNavLabels(),
  ]);
  return buildAdminNavGroups(menu, sections, labels);
});

/** 角色與權限頁的矩陣:側欄分區 → 一頁一列。 */
export async function getAccessSections(): Promise<AccessSection[]> {
  return deriveAccessSections(await getFullAdminNavGroups());
}
