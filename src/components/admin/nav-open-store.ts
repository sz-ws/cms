import { useSyncExternalStore } from "react";

// 1.43.0:側欄的分區與資料夾開合,記在這台瀏覽器的 localStorage。
//
// 只記「使用者自己點過的」:沒點過的分區/資料夾照舊跟著目前頁面決定開合
// (AdminSidebar 的預設規則)。以前這些覆寫放在 useState,重新整理或重新登入就沒了。
//
// server render 讀不到 localStorage,第一版一律用預設;hydrate 後 useSyncExternalStore
// 換成記住的狀態,不會有 hydration mismatch。同一個瀏覽器開兩個分頁時,另一邊點了
// 這邊也會跟著變(storage 事件)。
//
// 不綁使用者:開合不是敏感資料,同一台電腦換人登入沿用也無妨。

export const ADMIN_NAV_STORAGE_KEY = "cms.adminNavOpen";
/** 每一類最多記幾筆,最早點的先丟(分區/資料夾改名或拿掉後,舊 key 不會一直累積)。 */
const MAX_ENTRIES = 100;
const MAX_ID = 200;

export interface NavOpenState {
  /** 分區 id → 是否展開。 */
  groups: Readonly<Record<string, boolean>>;
  /** 資料夾 href(第一個子項)→ 是否展開。 */
  folders: Readonly<Record<string, boolean>>;
}

const EMPTY: NavOpenState = { groups: {}, folders: {} };

let snapshot: NavOpenState | null = null;
const listeners = new Set<() => void>();

function parseMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [id, open] of Object.entries(value)) {
    if (typeof open === "boolean" && id.length > 0 && id.length <= MAX_ID) out[id] = open;
  }
  return out;
}

/** localStorage 裡的字串 → 狀態;壞掉或不是這個形狀就當沒記過。 */
export function parseNavOpen(raw: string | null): NavOpenState {
  if (!raw) return EMPTY;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return EMPTY;
    const { groups, folders } = value as { groups?: unknown; folders?: unknown };
    return { groups: parseMap(groups), folders: parseMap(folders) };
  } catch {
    return EMPTY;
  }
}

function load(): NavOpenState {
  try {
    return parseNavOpen(window.localStorage.getItem(ADMIN_NAV_STORAGE_KEY));
  } catch {
    // 無痕模式、停用 storage:當沒記過,照預設開合。
    return EMPTY;
  }
}

function getSnapshot(): NavOpenState {
  if (snapshot === null) snapshot = load();
  return snapshot;
}

function getServerSnapshot(): NavOpenState {
  return EMPTY;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== ADMIN_NAV_STORAGE_KEY) return;
  snapshot = load();
  notify();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

/** 記下一次點擊。最近點的排最後,超過 MAX_ENTRIES 從最早的丟。 */
export function setNavOpen(kind: keyof NavOpenState, id: string, open: boolean): void {
  if (!id || id.length > MAX_ID) return;
  const current = getSnapshot();
  const kept = Object.entries(current[kind]).filter(([key]) => key !== id);
  const next = Object.fromEntries([...kept, [id, open] as const].slice(-MAX_ENTRIES));
  snapshot = { ...current, [kind]: next };
  try {
    window.localStorage.setItem(ADMIN_NAV_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // 存不進去(配額、無痕):這個分頁仍照點的開合,只是重新整理後不記得。
  }
  notify();
}

/** 目前記住的開合。server render 與 hydrate 的第一次 render 是空的。 */
export function useNavOpen(): NavOpenState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** 測試用:丟掉模組裡快取的狀態,下次重新讀 localStorage。 */
export function resetNavOpenForTest(): void {
  snapshot = null;
}
