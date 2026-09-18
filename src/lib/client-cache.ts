// 1.41.0:插件工作區「上次看到的資料」,換頁回來先顯示,背景再重抓。
//
// 後台的插件頁(訂單、經銷、推薦…)都是 client 元件自己 fetch。換頁時元件被卸下,
// 資料跟著丟,切回來又從「載入中」開始。這裡用記憶體留住最後一次成功的回應:
//
//   const [fresh, setFresh] = useState<Snapshot | null>(null);
//   const key = `shop-operations:${page}:${status}`;
//   const data = fresh ?? readCached<Snapshot>(key) ?? null;   // render 時讀,沒有副作用
//   …fetch 成功後:setFresh(result); writeCached(key, result);
//
// - 只活在這個分頁的記憶體裡:重新整理、登出登入(整頁跳轉)就清空,不寫 storage。
// - 只在瀏覽器存取。server render 時讀不到也寫不進 —— module 層的 Map 在 Workers 上
//   是跨請求共用的,不能讓一個人的資料出現在別人的畫面上。
// - 最多留 MAX 筆,最早寫進來的先丟。

const MAX = 40;
const store = new Map<string, unknown>();

const inBrowser = () => typeof window !== "undefined";

/** 上次存的資料;沒有時 undefined。純讀取,render 裡呼叫也安全。 */
export function readCached<T>(key: string): T | undefined {
  if (!inBrowser()) return undefined;
  return store.get(key) as T | undefined;
}

export function writeCached(key: string, value: unknown): void {
  if (!inBrowser()) return;
  store.delete(key);
  store.set(key, value);
  while (store.size > MAX) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** 丟掉某個前綴底下的資料(例如某插件在動作後要求下次一定重抓)。沒給前綴 = 全部。 */
export function dropCached(prefix = ""): void {
  for (const key of [...store.keys()]) if (key.startsWith(prefix)) store.delete(key);
}
