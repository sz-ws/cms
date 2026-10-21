import { utf8, hexToBytes, bytesToHex } from "@/ext/payment-kit";

// 藍新金流(NewebPay)MPG 2.0 專屬的加解密 —— 全部走 WebCrypto,零新依賴。
// 通用工具(hex/utf8/constant-time compare)在 @/ext/payment-kit/util。
//
// 協定(藍新 NDNF-1.0.6 MPG 串接手冊):
//   TradeInfo = AES-256-CBC(HashKey, HashIV, PKCS7, querystring) → lowercase hex
//   TradeSha  = UPPER(SHA256("HashKey=<key>&<TradeInfo hex>&HashIV=<iv>")) → hex
// HashKey 固定 32 字元、HashIV 固定 16 字元(商店後台核發,ASCII)。
// 加密:WebCrypto 的 AES-CBC 內建 16 bytes 一塊的 PKCS#7,藍新收得下(它去填充時看最後一個 byte 是幾)。
// 解密:藍新自己是 32 bytes 一塊地補(decryptTradeInfo 上面的說明),不能交給 WebCrypto 檢查填充。

export const HASH_KEY_LENGTH = 32;
export const HASH_IV_LENGTH = 16;

function assertKeyIv(hashKey: string, hashIv: string): void {
  if (hashKey.length !== HASH_KEY_LENGTH || hashIv.length !== HASH_IV_LENGTH) {
    throw new Error(
      `[newebpay] HashKey must be ${HASH_KEY_LENGTH} chars and HashIV ${HASH_IV_LENGTH} chars`,
    );
  }
}

async function importAesKey(hashKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    utf8(hashKey),
    { name: "AES-CBC" },
    false,
    ["encrypt", "decrypt"],
  );
}

/** 交易參數 querystring → TradeInfo(lowercase hex)。 */
export async function encryptTradeInfo(
  plain: string,
  hashKey: string,
  hashIv: string,
): Promise<string> {
  assertKeyIv(hashKey, hashIv);
  const key = await importAesKey(hashKey);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: utf8(hashIv) },
    key,
    utf8(plain),
  );
  return bytesToHex(cipher);
}

// 藍新回呼的 TradeInfo 是以 32 bytes 為一塊補齊的 PKCS7(官方 PHP 範例 addpadding($string, $blocksize = 32)):
// 最後補 1–32 個 byte,每個都等於補的個數。WebCrypto 的 AES-CBC 解密只認 16 bytes 一塊的 PKCS7(最多 16 個),
// 補了 17–32 個的那一半回呼會直接丟例外(0.2.1 以前就是這樣解不開)。
const MAX_PADDING = 32;

/** 去掉藍新的填充:最後一個 byte 是 n(1–32),最後 n 個 byte 都等於 n。不合 = null。 */
function stripPadding(bytes: Uint8Array): Uint8Array | null {
  const n = bytes[bytes.length - 1];
  if (!n || n > MAX_PADDING || n > bytes.length) return null;
  for (let i = bytes.length - n; i < bytes.length; i += 1) if (bytes[i] !== n) return null;
  return bytes.subarray(0, bytes.length - n);
}

/**
 * TradeInfo(hex)→ 明文字串。任何解碼/解密失敗回 null(呼叫端視為無效回呼),
 * 不 throw —— 這是處理外部輸入的邊界。
 *
 * 為了讓 WebCrypto 不檢查藍新的填充:在密文後面多接一塊「解開正好是 16 個 0x10」的密文(用最後一塊密文當 IV
 * 加密空字串得到),WebCrypto 只拿掉這一塊;藍新原本的填充留在明文裡,再照上面的規則自己去掉。16 bytes 一塊的
 * 標準 PKCS7(encryptTradeInfo 自己產的)也符合同一條規則。填充不合、或不是合法的 UTF-8 → null。
 */
export async function decryptTradeInfo(
  tradeInfoHex: string,
  hashKey: string,
  hashIv: string,
): Promise<string | null> {
  assertKeyIv(hashKey, hashIv);
  const bytes = hexToBytes(tradeInfoHex.trim().toLowerCase());
  if (!bytes || bytes.length % 16 !== 0) return null;
  try {
    const key = await importAesKey(hashKey);
    const lastBlock = bytes.slice(bytes.length - 16);
    const tail = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-CBC", iv: lastBlock }, key, new Uint8Array(0)),
    );
    const sealed = new Uint8Array(bytes.length + tail.length);
    sealed.set(bytes);
    sealed.set(tail, bytes.length);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-CBC", iv: utf8(hashIv) }, key, sealed),
    );
    const unpadded = stripPadding(plain);
    if (!unpadded) return null; // 填充不合 = 非本商店密鑰加密的資料。
    return new TextDecoder("utf-8", { fatal: true }).decode(unpadded);
  } catch {
    return null;
  }
}

/** TradeSha:UPPER(SHA256("HashKey=<key>&<TradeInfo>&HashIV=<iv>"))。 */
export async function tradeSha(
  tradeInfoHex: string,
  hashKey: string,
  hashIv: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    utf8(`HashKey=${hashKey}&${tradeInfoHex}&HashIV=${hashIv}`),
  );
  return bytesToHex(digest).toUpperCase();
}
