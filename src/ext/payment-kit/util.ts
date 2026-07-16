// payment-kit:gateway adapter 共用的位元組/比較工具(WebCrypto 周邊,零依賴)。

/** UTF-8 編碼成獨立 ArrayBuffer 上的 bytes(crypto.subtle 各 API 通吃的形狀)。 */
export function utf8(s: string): Uint8Array<ArrayBuffer> {
  const src = new TextEncoder().encode(s);
  const out = new Uint8Array(new ArrayBuffer(src.length));
  out.set(src);
  return out;
}

/** hex 字串 → bytes;非法字元/奇數長度 → null(呼叫端當作驗證/解密失敗)。 */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  // 先整串驗字元集 —— parseInt 對 "0g" 這種只解析前綴、不回 NaN,擋不住髒輸入。
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let hex = "";
  for (const b of view) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * constant-time 字串比較(簽章/digest 核對用)。長度不同立即 false —— 長度本身
 * 非秘密(digest hex 長度固定);內容比較不提早返回。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
