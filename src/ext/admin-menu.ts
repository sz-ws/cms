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
  /** 1.39.0:側欄分區。缺省依路由判斷(/admin/ext/* → content)。 */
  section?: AdminMenuSection;
  /** 1.39.0:子項。有子項的項目渲染成可折疊資料夾,href 指向第一個子項。 */
  children?: AdminMenuItem[];
}

export { isInlineSvgIcon };

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
  adminPages?: Pick<AdminPage, "slug" | "title" | "showInMenu">[];
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
  for (const ext of exts) {
    const pages = (ext.adminPages ?? [])
      .filter((page) => page.showInMenu !== false)
      .map((page) => ({
        href: `/admin/ext/${ext.id}${page.slug ? `/${page.slug}` : ""}`,
        title: resolve(page.title) || page.slug || ext.id,
      }));
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
