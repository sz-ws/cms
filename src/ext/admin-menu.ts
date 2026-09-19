import { z } from "zod";
import type { LocalizedString } from "@/lib/i18n/localized";
import { validateSvg } from "./dx/svg-guard";
import { isInlineSvgIcon } from "./admin-icon";
import type { AdminPage } from "./types";

// 1.39.0:admin 側欄的資料模型 —— 分區、巢狀、自訂圖示。
//
// 在此之前每個 enabled extension 的每一頁都平鋪進「內容」一組:裝了一套商務插件的
// 站台,側欄會是十幾個不分主從的連結(訂單、對帳佇列、運費、優惠碼、銀行轉帳……
// 全部同一層、全部叫「內容」)。這裡讓 extension 宣告兩件事:
//
//   - `menu.section`:放在哪一區(content / commerce / system)。
//   - `menu.parent`:掛到另一個 extension 的選單底下(付款方式掛在商店底下)。
//
// 多頁的 extension 不必宣告就會收成一個資料夾(標題 = extension 名稱)。巢狀刻意
// 只有一層:側欄 14rem 寬,兩層縮排之後標籤就剩三四個字。
//
// 本檔是純函式 + zod schema,不碰 React / D1,layout、AdminShell、manifest 驗證
// 與測試共用同一份規則。

export const ADMIN_MENU_SECTIONS = ["content", "commerce", "system"] as const;
export type AdminMenuSection = (typeof ADMIN_MENU_SECTIONS)[number];

export interface ExtensionMenu {
  /** 側欄分區;缺省 "content"。 */
  section?: AdminMenuSection;
  /**
   * 掛到另一個 extension(id)的選單底下。對方未啟用、沒有可見頁面,或宣告成環
   * (A→B→A)時,退回自己的頂層位置 —— 側欄永遠不會因為相依沒裝而少一個入口。
   */
  parent?: string;
  /** 同分區內排序,小的在前;缺省 100,同值維持 registry 順序。 */
  order?: number;
}

export interface AdminMenuItem {
  href: string;
  title: string;
  order?: number;
  /** 圖示代號(見 adminNavIcons.tsx)或內嵌 `<svg>`(1.39.0,須過 svg-guard)。 */
  icon?: string;
  /**
   * 1.39.0:側欄分區。缺省依路由判斷(/admin/ext/* → content)。
   * 1.40.0:filter:adminMenu 可指定任何分區 id(含站台用 filter:adminSections 加的);
   * 不存在的分區退回「內容」。manifest 的 `menu.section` 仍只收三個內建值。
   */
  section?: AdminMenuSection | AdminNavSectionId;
  /** 1.39.0:子項。有子項的項目渲染成可折疊資料夾,href 指向第一個子項。 */
  children?: AdminMenuItem[];
}

export { isInlineSvgIcon };

// 1.40.0:側欄分區本身也交給站台。
//
// 1.39.0 的五區(工作區 / 內容 / 商務 / 市集 / 系統)名稱與順序寫死在 AdminShell;
// 客戶要「商務」叫別的名字、多一區、或分區多到要收合,只能改 core 檔。現在分區是
// 一份資料:core 給預設,filter:adminSections 讓站台改名、加區、排序、決定收合方式;
// 項目用 `section` 指到分區 id(filter:adminMenu 可改任何項目的歸屬)。

export type AdminNavSectionId = string;

export const BUILTIN_NAV_SECTIONS = [
  "workspace",
  "content",
  "commerce",
  "shop",
  "system",
] as const;
export type BuiltinNavSection = (typeof BUILTIN_NAV_SECTIONS)[number];

export interface AdminNavSection {
  id: AdminNavSectionId;
  label: string;
  /** 小的在前。內建:workspace 0、content 20、commerce 40、shop 60、system 80。 */
  order: number;
  /**
   * "open"(缺省):展開,可手動收合。
   * "active":只有目前頁面所在的那一區展開,其餘收合 —— 分區一多,側欄才看得完。
   */
  collapse?: "open" | "active";
}

const BUILTIN_SECTION_ORDER: Record<BuiltinNavSection, number> = {
  workspace: 0,
  content: 20,
  commerce: 40,
  shop: 60,
  system: 80,
};

export function defaultAdminSections(
  labels: Record<BuiltinNavSection, string>,
): AdminNavSection[] {
  return BUILTIN_NAV_SECTIONS.map((id) => ({
    id,
    label: labels[id],
    order: BUILTIN_SECTION_ORDER[id],
  }));
}

const SECTION_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * filter:adminSections 的輸出是 extension 給的,渲染前在這裡收斂:丟掉形狀不對的、
 * 同 id 留第一個、依 order 排(同值維持原順序)。整份不是陣列或全被丟光就回預設 ——
 * 一個寫壞的 filter 不能讓側欄整個消失。
 */
export function normalizeAdminSections(
  value: unknown,
  fallback: AdminNavSection[],
): AdminNavSection[] {
  if (!Array.isArray(value)) return fallback;
  const seen = new Set<string>();
  const sections: AdminNavSection[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const { id, label, order, collapse } = raw as Record<string, unknown>;
    if (typeof id !== "string" || !SECTION_ID_RE.test(id) || seen.has(id)) continue;
    if (typeof label !== "string" || label.trim() === "") continue;
    if (typeof order !== "number" || !Number.isFinite(order)) continue;
    seen.add(id);
    sections.push({
      id,
      label,
      order,
      ...(collapse === "active" || collapse === "open" ? { collapse } : {}),
    });
  }
  if (sections.length === 0) return fallback;
  return sections
    .map((section, index) => ({ section, index }))
    .sort((a, b) => a.section.order - b.section.order || a.index - b.index)
    .map(({ section }) => section);
}

const EXT_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const DEFAULT_ORDER = 100;

export const extensionMenuSchema = z
  .object({
    section: z.enum(ADMIN_MENU_SECTIONS).optional(),
    parent: z.string().regex(EXT_ID_RE, "invalid parent extension id").optional(),
    order: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

/**
 * icon 欄位的驗證訊息;合法回 null。代號不在這裡擋 —— 不認得的代號本來就退回
 * 關鍵字推測(adminNavIcons.tsx),收緊會讓既有 manifest 突然裝不起來。
 */
export function adminIconIssue(icon: string): string | null {
  if (!isInlineSvgIcon(icon)) return null;
  const result = validateSvg(icon);
  return result.ok ? null : `invalid icon svg: ${result.reason}`;
}

/** 渲染前的最後一道:內嵌 SVG 沒過 svg-guard 就丟掉(filter:adminMenu 塞進來的也算)。 */
export function safeAdminIcon(icon: string | undefined): string | undefined {
  if (!icon) return undefined;
  return adminIconIssue(icon) === null ? icon : undefined;
}

export interface MenuExtension {
  id: string;
  name: LocalizedString;
  icon?: string;
  menu?: ExtensionMenu;
  adminPages?: Pick<AdminPage, "slug" | "title" | "showInMenu" | "replaces">[];
}

/** extension 後台頁的網址。slug "" = 主頁。 */
export function adminPageHref(extId: string, slug: string): string {
  return `/admin/ext/${extId}${slug ? `/${slug}` : ""}`;
}

const PAGE_REF_RE = /^[a-z][a-z0-9-]{1,30}(\/[a-z0-9][a-z0-9-]*)*$/;

/**
 * 1.46.0:被取代的頁 → 取代它的頁(AdminPage.replaces)。只看傳進來的(已啟用的)extension。
 *
 * 側欄把被取代的頁拿掉;/admin/ext/[extId]/[[...page]] 把它的網址轉到取代者。
 * 取代者自己又被取代時,一路追到最後那一頁;繞成一圈的全部不算(兩邊都留著),
 * 不然兩頁互相轉址、側欄也兩頁都不見。自己取代自己、格式不對的 ref 也不算。
 */
export function replacedAdminPages(exts: readonly MenuExtension[]): Map<string, string> {
  const direct = new Map<string, string>();
  for (const ext of exts) {
    for (const page of ext.adminPages ?? []) {
      for (const ref of page.replaces ?? []) {
        if (!PAGE_REF_RE.test(ref)) continue;
        const [targetId, ...rest] = ref.split("/");
        if (targetId === ext.id) continue;
        const target = adminPageHref(targetId, rest.join("/"));
        if (!direct.has(target)) direct.set(target, adminPageHref(ext.id, page.slug));
      }
    }
  }
  const out = new Map<string, string>();
  for (const [from, to] of direct) {
    const seen = new Set([from]);
    let end = to;
    while (direct.has(end) && !seen.has(end)) {
      seen.add(end);
      end = direct.get(end)!;
    }
    if (!seen.has(end)) out.set(from, end);
  }
  return out;
}

/**
 * enabled extensions → 側欄的 extension 項目(頂層 + 一層子項)。
 *
 * - 單頁、沒有別人掛進來:一個連結,標題是那一頁的標題。
 * - 多頁,或有別的 extension 掛進來:一個資料夾,標題是 extension 名稱,子項依序是
 *   自己的頁面、再來是掛進來的頁面。子項標題與資料夾同名時改叫 `overviewTitle`,
 *   免得出現「商城營運 › 商城營運」。
 */
export function buildExtensionMenu(
  exts: readonly MenuExtension[],
  resolve: (value: LocalizedString | undefined) => string | undefined,
  overviewTitle: string,
): AdminMenuItem[] {
  const nodes = new Map<string, { ext: MenuExtension; pages: AdminMenuItem[] }>();
  // 1.46.0:被別的 extension 取代的頁不進側欄。
  const replaced = replacedAdminPages(exts);
  for (const ext of exts) {
    const pages = (ext.adminPages ?? [])
      .filter((page) => page.showInMenu !== false)
      .map((page) => ({
        href: adminPageHref(ext.id, page.slug),
        title: resolve(page.title) || page.slug || ext.id,
      }))
      .filter((page) => !replaced.has(page.href));
    if (pages.length > 0) nodes.set(ext.id, { ext, pages });
  }

  const rootOf = (id: string): string => {
    const seen = new Set([id]);
    let current = id;
    for (;;) {
      const parent = nodes.get(current)?.ext.menu?.parent;
      if (!parent || !nodes.has(parent)) return current;
      // 環:整條鏈都不巢狀,各自回頂層(否則環上的每一個都會掛在別人底下而消失)。
      if (seen.has(parent)) return id;
      seen.add(parent);
      current = parent;
    }
  };

  const nested = new Map<string, AdminMenuItem[]>();
  for (const [id, node] of nodes) {
    const root = rootOf(id);
    if (root === id) continue;
    nested.set(root, [...(nested.get(root) ?? []), ...node.pages]);
  }

  const items: AdminMenuItem[] = [];
  for (const [id, node] of nodes) {
    if (rootOf(id) !== id) continue;
    const placement = {
      icon: node.ext.icon,
      section: node.ext.menu?.section ?? "content",
      order: node.ext.menu?.order,
    } satisfies Partial<AdminMenuItem>;
    const guests = nested.get(id) ?? [];
    if (node.pages.length === 1 && guests.length === 0) {
      items.push({ ...node.pages[0], ...placement });
      continue;
    }
    const title = resolve(node.ext.name) || id;
    const children = [...node.pages, ...guests].map((child) =>
      child.title === title ? { ...child, title: overviewTitle } : child,
    );
    items.push({ href: children[0].href, title, ...placement, children });
  }

  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        (a.item.order ?? DEFAULT_ORDER) - (b.item.order ?? DEFAULT_ORDER) ||
        a.index - b.index,
    )
    .map(({ item }) => item);
}
