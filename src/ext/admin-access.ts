import type { AdminMenuItem } from "./admin-menu";

// 1.50.0:自訂角色的規則 —— 哪些後台頁可以授權、一個角色對某一頁 / 某一條 API 有什麼
// 權限、側欄怎麼依角色過濾、角色與權限頁的矩陣從哪裡來。
//
// 純函式,不碰 React / D1:layout、頁面守門、API dispatch、角色頁與測試共用同一份。
//
// 授權的單位是「後台頁」,鍵是它的路徑(/admin、/admin/media、/admin/ext/<id>[/<slug>])。
// 矩陣的列直接取自側欄(core + 啟用中的插件 + 站台的 filter:adminMenu),所以新裝插件的
// 頁自動出現,而且對既有的自訂角色一律是「無」。站台改名、搬分區不影響授權:鍵是路徑。
//
// 三個預設角色(admin / editor / guest)不走這裡的授權:它們的行為與 1.49.0 相同。
// 自訂角色只會縮小權限 —— 在被授權的頁與 API 裡以管理者身分執行,其餘地方是一般
// 登入者(requireAuth("admin") 一律不過)。設定、成員、角色與擴充功能永遠只有管理者。

export const ACCESS_LEVELS = ["none", "view", "edit"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export type GrantedLevel = Exclude<AccessLevel, "none">;
/** 後台頁路徑 → 權限。沒列的頁 = "none"。 */
export type AccessMap = Readonly<Record<string, GrantedLevel>>;

const RANK: Record<AccessLevel, number> = { none: 0, view: 1, edit: 2 };

export function atLeast(level: AccessLevel, needed: AccessLevel): boolean {
  return RANK[level] >= RANK[needed];
}

function higher(a: AccessLevel, b: AccessLevel): AccessLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

/** 兩級裡低的那一級(把門縮到某一頁時用:兩邊都要夠)。 */
export function lowerLevel(a: AccessLevel, b: AccessLevel): AccessLevel {
  return RANK[a] <= RANK[b] ? a : b;
}

/** 這個 HTTP method 需要的權限:讀是檢視,其餘是編輯。 */
export function neededFor(method: string): GrantedLevel {
  return method === "GET" || method === "HEAD" ? "view" : "edit";
}

export const DASHBOARD_PATH = "/admin";
export const MEDIA_PATH = "/admin/media";
const EXT_PREFIX = "/admin/ext/";

/** 後台連結的路徑部分:去掉 query / hash 與結尾斜線。 */
export function areaKey(href: string): string {
  const path = href.split(/[?#]/, 1)[0] ?? "";
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

const ADMIN_ONLY_PREFIXES = [
  "/admin/settings",
  "/admin/users",
  "/admin/roles",
  "/admin/extensions",
  "/admin/agent",
];

/** 只有管理者能用的頁:自訂角色永遠授權不到。 */
export function isAdminOnlyPath(key: string): boolean {
  return ADMIN_ONLY_PREFIXES.some((p) => key === p || key.startsWith(`${p}/`));
}

const EXT_PATH_RE = /^\/admin\/ext\/[a-z][a-z0-9-]{1,30}(\/[a-z0-9][a-z0-9-]*)*$/;

/** 自訂角色可以被授權的頁:儀表板、媒體庫、插件的後台頁。 */
export function isGrantablePath(key: string): boolean {
  return key === DASHBOARD_PATH || key === MEDIA_PATH || EXT_PATH_RE.test(key);
}

/**
 * 這一頁最多能給到哪一級。儀表板只有看:它上面唯一能改的(洞察區)寫的是站台設定。
 */
export function maxLevelFor(key: string): GrantedLevel {
  return key === DASHBOARD_PATH ? "view" : "edit";
}

/** 後台頁參照 "<extId>" / "<extId>/<slug>"(同 AdminPage.replaces)→ 路徑;格式不對回 null。 */
export function pageRefPath(ref: string): string | null {
  const path = `${EXT_PREFIX}${ref}`;
  return EXT_PATH_RE.test(path) ? path : null;
}

export function levelOf(access: AccessMap, key: string): AccessLevel {
  if (!isGrantablePath(key)) return "none";
  const level = Object.prototype.hasOwnProperty.call(access, key) ? access[key] : undefined;
  return level === "view" || level === "edit" ? level : "none";
}

/** 一個 extension 的所有後台頁裡最高的那一級(沒宣告 accessAs 的 API 用這個)。 */
export function extensionLevel(access: AccessMap, extId: string): AccessLevel {
  const root = `${EXT_PREFIX}${extId}`;
  let level: AccessLevel = "none";
  for (const key of Object.keys(access)) {
    if (key === root || key.startsWith(`${root}/`)) level = higher(level, levelOf(access, key));
  }
  return level;
}

/**
 * 一個插件後台頁需要看哪一頁的權限:宣告了 accessAs 的(明細頁、編輯頁)跟著那一頁,
 * 否則就是它自己。accessAs 格式不對時當作沒授權,不退回別頁。
 */
export function adminPageAccessPath(
  extId: string,
  page: { slug: string; accessAs?: string },
): string | null {
  if (page.accessAs !== undefined) return pageRefPath(page.accessAs);
  return pageRefPath(page.slug ? `${extId}/${page.slug}` : extId);
}

export function adminPageLevel(
  access: AccessMap,
  extId: string,
  page: { slug: string; accessAs?: string },
): AccessLevel {
  const path = adminPageAccessPath(extId, page);
  return path ? levelOf(access, path) : "none";
}

/**
 * 一條插件 API 的權限:宣告了 accessAs 就看那一頁;沒宣告就看這個 extension 所有頁
 * 裡最高的一級(同一個插件的頁通常共用一組 API)。
 */
export function apiRouteLevel(
  access: AccessMap,
  extId: string,
  route: { accessAs?: string },
): AccessLevel {
  if (route.accessAs !== undefined) {
    const path = pageRefPath(route.accessAs);
    return path ? levelOf(access, path) : "none";
  }
  return extensionLevel(access, extId);
}

/**
 * declarative extension 的 CRUD route 跟著哪一頁:每個 content type 對到第一個顯示它的
 * 後台頁。options(關聯欄位的挑選清單,只有 id 與標題)不綁 —— 別的頁的表單也要挑它,
 * 退回「這個 extension 任一頁」;沒有後台頁的 type 同樣退回(回 undefined)。
 */
export function declarativeRouteAccess(
  extId: string,
  adminPages: readonly { slug: string; contentType: string }[],
): (typeName: string, routePath: string) => string | undefined {
  const pageOf = new Map<string, string>();
  for (const page of adminPages) {
    if (!pageOf.has(page.contentType)) {
      pageOf.set(page.contentType, page.slug ? `${extId}/${page.slug}` : extId);
    }
  }
  return (typeName, routePath) =>
    routePath === `${typeName}/options` ? undefined : pageOf.get(typeName);
}

/** 打得開(檢視以上)的頁數 —— 成員頁的角色說明用。 */
export function openablePageCount(access: AccessMap): number {
  return Object.keys(access).filter((key) => atLeast(levelOf(access, key), "view")).length;
}

/** 有沒有任何一頁可以編輯(內容表單裡的媒體挑選與上傳用這個)。 */
export function canEditAnything(access: AccessMap): boolean {
  return Object.keys(access).some((key) => levelOf(access, key) === "edit");
}

/** 角色名稱的長度上限(成員頁的選單放得下)。 */
export const ROLE_NAME_MAX = 40;

const MAX_ENTRIES = 500;

/**
 * 存進資料庫 / 從資料庫讀出的 access 收斂:只留可授權的路徑與 view/edit,超過該頁上限的
 * 往下壓(儀表板的 edit → view)。形狀不對的整份當作空的 —— 讀壞的角色什麼都不能做,
 * 而不是什麼都能做。
 */
export function sanitizeAccess(value: unknown): AccessMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, GrantedLevel> = {};
  let n = 0;
  for (const [rawKey, level] of Object.entries(value as Record<string, unknown>)) {
    if (n >= MAX_ENTRIES) break;
    const key = areaKey(rawKey);
    if (!isGrantablePath(key)) continue;
    if (level !== "view" && level !== "edit") continue;
    out[key] = level === "edit" && maxLevelFor(key) === "view" ? "view" : level;
    n++;
  }
  return out;
}

export function parseStoredAccess(raw: string | null | undefined): AccessMap {
  if (!raw) return {};
  try {
    return sanitizeAccess(JSON.parse(raw));
  } catch {
    return {};
  }
}

// ---- 矩陣(角色與權限頁)----

/** 側欄群組的形狀(components/admin/nav-groups.ts buildAdminNavGroups 的輸出)。 */
export interface NavGroupLike {
  id: string;
  label: string;
  items: readonly {
    href: string;
    title: string;
    children?: readonly { href: string; title: string }[];
  }[];
}

export interface AccessArea {
  key: string;
  title: string;
  /** 巢狀在資料夾裡的頁:資料夾名稱。 */
  folder?: string;
  /** 只有管理者能用(設定、成員……),矩陣畫成鎖住的一列。 */
  locked?: boolean;
  /** 這一頁最多能給到哪一級。 */
  max: GrantedLevel;
}

export interface AccessSection {
  id: string;
  label: string;
  areas: AccessArea[];
}

/**
 * 側欄群組(buildAdminNavGroups 的輸出,以管理者看到的完整選單建)→ 矩陣。
 * 一頁一列;資料夾展開成它的子頁。同一路徑出現兩次(站台用 query 做了篩選捷徑)
 * 只留第一個。不是後台頁的連結(外部網址)不進矩陣。
 */
export function deriveAccessSections(groups: readonly NavGroupLike[]): AccessSection[] {
  const seen = new Set<string>();
  const sections: AccessSection[] = [];
  for (const group of groups) {
    const areas: AccessArea[] = [];
    const add = (href: string, title: string, folder?: string) => {
      const key = areaKey(href);
      if (isAdminOnlyPath(key)) {
        areas.push({ key, title, ...(folder ? { folder } : {}), locked: true, max: "edit" });
        return;
      }
      if (!isGrantablePath(key) || seen.has(key)) return;
      seen.add(key);
      areas.push({ key, title, ...(folder ? { folder } : {}), max: maxLevelFor(key) });
    };
    for (const item of group.items) {
      if (item.children?.length) {
        for (const child of item.children) add(child.href, child.title, item.title);
      } else {
        add(item.href, item.title);
      }
    }
    if (areas.length > 0) sections.push({ id: group.id, label: group.label, areas });
  }
  return sections;
}

export type PresetRole = "admin" | "editor" | "guest";

/** 編輯者今天能打開的後台頁:儀表板(與自己的帳戶)。 */
const EDITOR_PRESET: AccessMap = { [DASHBOARD_PATH]: "view" };

/** 預設角色畫在矩陣上的樣子(唯讀),也是「以這個角色為基礎新增」的起點。 */
export function presetAccess(
  preset: PresetRole,
  sections: readonly AccessSection[],
): AccessMap {
  if (preset === "guest") return {};
  if (preset === "editor") return EDITOR_PRESET;
  const out: Record<string, GrantedLevel> = {};
  for (const section of sections) {
    for (const area of section.areas) if (!area.locked) out[area.key] = area.max;
  }
  return out;
}

// ---- 側欄 ----

/**
 * 依「這個路徑打不打得開」過濾選單:打不開的項目拿掉;資料夾只留打得開的子頁,
 * 一個都不剩就整個拿掉,href 改成第一個留下的子頁。帳戶頁(個人)與不在後台的
 * 連結永遠留著。
 */
export function filterAdminMenu(
  menu: readonly AdminMenuItem[],
  canOpen: (key: string) => boolean,
): AdminMenuItem[] {
  const open = (href: string) => {
    if (!href.startsWith("/admin")) return true;
    const key = areaKey(href);
    return key === "/admin/account" || canOpen(key);
  };
  const out: AdminMenuItem[] = [];
  for (const item of menu) {
    if (item.children?.length) {
      const children = item.children.filter((child) => open(child.href));
      if (children.length > 0) out.push({ ...item, href: children[0].href, children });
      continue;
    }
    if (open(item.href)) out.push(item);
  }
  return out;
}

/** 自訂角色看得到的頁:檢視以上。 */
export function customRoleCanOpen(access: AccessMap): (key: string) => boolean {
  return (key) => atLeast(levelOf(access, key), "view");
}

/** 編輯者今天打得開的頁(其餘會被 requireAuth("admin") 擋下)。 */
export function editorCanOpen(key: string): boolean {
  return key === DASHBOARD_PATH;
}

/** 側欄順序裡第一個打得開的頁(自訂角色沒有儀表板時,登入後落在這裡)。 */
export function firstOpenablePath(
  groups: readonly NavGroupLike[],
  canOpen: (key: string) => boolean,
): string | null {
  for (const group of groups) {
    for (const item of group.items) {
      const hrefs = item.children?.length ? item.children.map((c) => c.href) : [item.href];
      for (const href of hrefs) {
        if (!href.startsWith("/admin")) continue;
        const key = areaKey(href);
        if (isGrantablePath(key) && canOpen(key)) return href;
      }
    }
  }
  return null;
}
