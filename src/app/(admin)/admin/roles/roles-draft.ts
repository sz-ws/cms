import {
  levelOf,
  sanitizeAccess,
  type AccessLevel,
  type AccessMap,
  type AccessSection,
  type GrantedLevel,
} from "@/ext/admin-access";

// 角色與權限頁的純函式:矩陣的一格 / 一整區怎麼改、兩份權限是否相同、角色列表的樂觀更新。
// 元件(RolesWorkspace)只管畫與送出;規則都在這裡,測試直接打。

export interface RoleDraft {
  name: string;
  access: AccessMap;
}

export interface RoleRow {
  id: string;
  name: string;
  access: AccessMap;
  members: number;
}

function withLevel(
  access: AccessMap,
  key: string,
  level: AccessLevel,
  max: GrantedLevel,
): AccessMap {
  const next: Record<string, GrantedLevel> = { ...access };
  if (level === "none") delete next[key];
  else next[key] = level === "edit" && max === "view" ? "view" : level;
  return next;
}

export function setAreaLevel(
  access: AccessMap,
  area: { key: string; max: GrantedLevel },
  level: AccessLevel,
): AccessMap {
  return withLevel(access, area.key, level, area.max);
}

/** 整區套用:每一頁設成這一級(超過該頁上限的壓到上限);鎖住的列不動。 */
export function setSectionLevel(
  access: AccessMap,
  section: AccessSection,
  level: AccessLevel,
): AccessMap {
  let next = access;
  for (const area of section.areas) {
    if (!area.locked) next = withLevel(next, area.key, level, area.max);
  }
  return next;
}

/**
 * 分區標題列顯示的值:每一頁都一樣就是那一級,不一樣是 null(混合)。
 * 只能檢視的頁(儀表板)在整區「編輯」時算作一致,不然整區設成編輯之後永遠顯示混合。
 */
export function sectionLevel(access: AccessMap, section: AccessSection): AccessLevel | null {
  const areas = section.areas.filter((area) => !area.locked);
  if (areas.length === 0) return null;
  const levels = areas.map((area) => levelOf(access, area.key));
  const top = levels.includes("edit") ? "edit" : levels[0];
  const same = areas.every((area, i) => {
    const expected = top === "edit" && area.max === "view" ? "view" : top;
    return levels[i] === expected;
  });
  return same ? top : null;
}

/** 這一區最多能給到哪一級(整區都是只能檢視的頁時,標題列也不給編輯)。 */
export function sectionMax(section: AccessSection): GrantedLevel {
  return section.areas.some((area) => !area.locked && area.max === "edit") ? "edit" : "view";
}

export function sameAccess(a: AccessMap, b: AccessMap): boolean {
  const left = sanitizeAccess(a);
  const right = sanitizeAccess(b);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (left[key] !== right[key]) return false;
  return true;
}

export function sameDraft(a: RoleDraft, b: RoleDraft): boolean {
  return a.name.trim() === b.name.trim() && sameAccess(a.access, b.access);
}

export type RolesAction =
  | { kind: "upsert"; role: RoleRow }
  | { kind: "remove"; id: string };

export function applyRolesAction(roles: readonly RoleRow[], action: RolesAction): RoleRow[] {
  if (action.kind === "remove") return roles.filter((role) => role.id !== action.id);
  const i = roles.findIndex((role) => role.id === action.role.id);
  if (i === -1) return [...roles, action.role];
  const next = [...roles];
  next[i] = action.role;
  return next;
}
