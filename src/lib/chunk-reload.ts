// 頁面的程式碼要不到時自動重新整理一次(src/app/global-error.tsx 用它)。純函式,有測試(test/chunk-reload.test.ts)。
//
// 「要不到」幾乎都是部署:瀏覽器手上是上一版的 HTML,指向上一版的 chunk 檔名,新版上線之後那些檔案不在了。
// 重新整理一次會拿到新的 HTML。但同一個網址重新整理過還是要不到(真的少了檔案、網路擋掉),再重來只會
// 變成無限重新整理 —— 所以記住「這個網址剛剛重新整理過」,一段時間內不再重來。

/** webpack 的 ChunkLoadError 之外,各家瀏覽器 import() 失敗時的訊息,以及 Turbopack、CSS chunk 的。 */
const CHUNK_MESSAGE =
  /Loading (CSS )?chunk \S+ failed|Failed to load chunk|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

/** 這個錯是不是「頁面的程式碼要不到」。丟出來的不一定是 Error,什麼都收。 */
export function isChunkLoadError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === "ChunkLoadError") return true;
  return typeof message === "string" && CHUNK_MESSAGE.test(message);
}

export const CHUNK_RELOAD_KEY = "cms:chunk-reload";
/** 同一個網址重新整理過之後,多久內不再自動重來。 */
export const CHUNK_RELOAD_WINDOW_MS = 60_000;

type ReloadStore = Pick<Storage, "getItem" | "setItem">;
type LastReload = { path: string; at: number };

/** 壞掉的紀錄當成沒有紀錄;讀不到(getItem 丟錯)照樣丟出去 —— 讀不到就記不住,不能放行。 */
function lastReload(store: ReloadStore): LastReload | null {
  const raw = store.getItem(CHUNK_RELOAD_KEY);
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const { path, at } = value as Record<string, unknown>;
    return typeof path === "string" && typeof at === "number" ? { path, at } : null;
  } catch {
    return null;
  }
}

/**
 * 要這個網址的那一次自動重新整理。回 true:記下來了,呼叫的人去重新整理;回 false:這個網址剛剛才重新
 * 整理過(或記不下來 —— 記不下來就不能保證不會一直重來),不要重新整理,畫錯誤畫面。
 */
export function claimChunkReload(store: ReloadStore | null, path: string, now: number): boolean {
  if (!store) return false;
  try {
    const last = lastReload(store);
    // 時間倒退(last.at 在未來)當成沒有紀錄。
    if (last && last.path === path && now >= last.at && now - last.at < CHUNK_RELOAD_WINDOW_MS) return false;
    store.setItem(CHUNK_RELOAD_KEY, JSON.stringify({ path, at: now } satisfies LastReload));
    return true;
  } catch {
    return false;
  }
}
