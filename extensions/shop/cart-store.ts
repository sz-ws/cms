// 商店購物車(client 端,localStorage)。
//
// 車只是結帳前的暫存 UI 狀態 —— 訂單才是事實:結帳時只送 productId + qty,
// 價格由伺服器重讀 catalog 計算(這裡存的 unitPrice 僅供顯示)。所以不需要
// D1 車表、不需要 guest session;等做棄單行銷再議伺服器端購物車。

export interface CartItem {
  productId: string;
  name: string;
  /** 顯示用單價(整數 TWD)。權威價格在伺服器。 */
  unitPrice: number;
  qty: number;
}

const KEY = "shop.cart.v1";
/** 內容變動時發出(同分頁);其他分頁走原生 storage 事件。 */
export const CART_EVENT = "shop:cart-changed";

export function readCart(): CartItem[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (i): i is CartItem =>
        i !== null &&
        typeof i === "object" &&
        typeof (i as CartItem).productId === "string" &&
        typeof (i as CartItem).name === "string" &&
        typeof (i as CartItem).unitPrice === "number" &&
        typeof (i as CartItem).qty === "number" &&
        (i as CartItem).qty > 0,
    );
  } catch {
    return [];
  }
}

function writeCart(items: CartItem[]): void {
  window.localStorage.setItem(KEY, JSON.stringify(items));
  snapshot = items;
  window.dispatchEvent(new CustomEvent(CART_EVENT));
}

// ---- useSyncExternalStore 介面(client 元件以此讀車,不自己碰 localStorage)----
// snapshot 需引用穩定(每次 getSnapshot 回新陣列會無限 re-render),故快取、
// 變動時作廢。server snapshot 恆為空陣列(hydration 後 React 自行補上 client 值)。

let snapshot: CartItem[] | null = null;
const EMPTY: CartItem[] = [];

export function subscribeCart(onChange: () => void): () => void {
  const invalidate = () => {
    snapshot = null;
    onChange();
  };
  window.addEventListener(CART_EVENT, invalidate);
  window.addEventListener("storage", invalidate);
  return () => {
    window.removeEventListener(CART_EVENT, invalidate);
    window.removeEventListener("storage", invalidate);
  };
}

export function getCartSnapshot(): CartItem[] {
  if (snapshot === null) snapshot = readCart();
  return snapshot;
}

export function getCartServerSnapshot(): CartItem[] {
  return EMPTY;
}

export function addToCart(item: Omit<CartItem, "qty">, qty = 1): void {
  const cart = readCart();
  const existing = cart.find((i) => i.productId === item.productId);
  const next = existing
    ? cart.map((i) =>
        i.productId === item.productId
          ? { ...i, qty: Math.min(i.qty + qty, 99), name: item.name, unitPrice: item.unitPrice }
          : i,
      )
    : [...cart, { ...item, qty: Math.min(qty, 99) }];
  writeCart(next);
}

export function setQty(productId: string, qty: number): void {
  const cart = readCart();
  const next =
    qty <= 0
      ? cart.filter((i) => i.productId !== productId)
      : cart.map((i) =>
          i.productId === productId ? { ...i, qty: Math.min(qty, 99) } : i,
        );
  writeCart(next);
}

export function clearCart(): void {
  writeCart([]);
  forgetLeftCheckout();
}

// 去刷卡(跳轉金流)時記下的那次送出:指紋與 requestId(sessionStorage,這個分頁)。客人從付款頁按上一頁、
// 或重新整理回到結帳頁,內容沒改就再送同一個 requestId,伺服器認得是同一筆訂單、給一份新的付款表單,
// 不會多出一張佔著庫存與優惠碼的訂單。購物車清空(付款完成、改匯款下單)時一起忘掉。
const LEFT_KEY = "shop.checkout.left";

export type LeftCheckout = { fingerprint: string; id: string };

export function rememberLeftCheckout(request: LeftCheckout): void {
  try {
    sessionStorage.setItem(LEFT_KEY, JSON.stringify(request));
  } catch {
    // 無痕視窗、儲存被擋:沒記下就照以前,再送是新的一筆。
  }
}

export function leftCheckout(): LeftCheckout | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(LEFT_KEY) ?? "null") as Partial<LeftCheckout> | null;
    return parsed && typeof parsed.fingerprint === "string" && typeof parsed.id === "string" ? { fingerprint: parsed.fingerprint, id: parsed.id } : null;
  } catch {
    return null;
  }
}

export function forgetLeftCheckout(): void {
  try {
    sessionStorage.removeItem(LEFT_KEY);
  } catch {
    // 同上。
  }
}

export function cartSubtotal(items: CartItem[]): number {
  return items.reduce((sum, i) => sum + i.unitPrice * i.qty, 0);
}
