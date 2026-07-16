import { utf8, hexToBytes, bytesToHex } from "@/ext/payment-kit";

// 藍新金流(NewebPay)MPG 2.0 專屬的加解密 —— 全部走 WebCrypto,零新依賴。
// 通用工具(hex/utf8/constant-time compare)在 @/ext/payment-kit/util。
//
// 協定(藍新 NDNF-1.0.6 MPG 串接手冊):
//   TradeInfo = AES-256-CBC(HashKey, HashIV, PKCS7, querystring) → lowercase hex
//   TradeSha  = UPPER(SHA256("HashKey=<key>&<TradeInfo hex>&HashIV=<iv>")) → hex
// HashKey 固定 32 字元、HashIV 固定 16 字元(商店後台核發,ASCII)。
// WebCrypto 的 AES-CBC encrypt/decrypt 內建 PKCS#7 padding,與藍新 PHP 範例
// (openssl + 手動 PKCS7)產出相同 —— 不需自己 pad。

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

/**
 * TradeInfo(hex)→ 明文字串。任何解碼/解密失敗回 null(呼叫端視為無效回呼),
 * 不 throw —— 這是處理外部輸入的邊界。
 */
export async function decryptTradeInfo(
  tradeInfoHex: string,
  hashKey: string,
  hashIv: string,
): Promise<string | null> {
  assertKeyIv(hashKey, hashIv);
  const bytes = hexToBytes(tradeInfoHex.trim().toLowerCase());
  if (!bytes) return null;
  try {
    const key = await importAesKey(hashKey);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: utf8(hashIv) },
      key,
      bytes,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null; // padding/長度不合 = 非本商店密鑰加密的資料。
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
