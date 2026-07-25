// AES-GCM secret 信封(02 §1)的**唯一**實作。
//
// 為什麼獨立成一個模組:secret 的加解密有兩個呼叫端,而它們拿金鑰的方式不同 ——
//   1. src/lib/settings.ts:跑在 Next 的 request 生命週期裡,金鑰經 getEnv()
//      (getCloudflareContext())取得。
//   2. custom-worker.ts 的 `scheduled` handler:Cloudflare 直接把 `env` 當參數傳進來,
//      **沒有** request context,呼叫 getCloudflareContext() 會 throw。
// 兩邊共用同一份信封邏輯,格式才不會漂移(信封沒有版本欄位,一旦兩份實作分歧就
// 解不回來)。因此本模組把金鑰材料當**參數**收,自己絕不碰 env。
//
// 硬規則:這個檔案只准依賴 Web Crypto / TextEncoder / atob / btoa 這類全域。
// **不准** import 任何 `@/` 別名、next/*、drizzle、./db、./settings —— 它會被打包進
// worker 的 `scheduled` 入口,任何 import 都可能把整個 Next module graph 拖進 bundle。
//
// 信封格式(與 02 §1 一致,勿改):
//   base64( 12-byte 隨機 IV ‖ AES-256-GCM 密文 )
// 金鑰材料 = Worker secret `SECRETS_KEY` 的 base64 解碼結果(32 bytes)。

// 以 ArrayBuffer 為 backing(避免 DOM/workerd lib 的 BufferSource 型別衝突)。
function bytes(len: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(len));
}

function fromBinary(s: string): Uint8Array<ArrayBuffer> {
  const out = bytes(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function enc(s: string): Uint8Array<ArrayBuffer> {
  const src = new TextEncoder().encode(s);
  const out = bytes(src.length);
  out.set(src);
  return out;
}

/** base64 的 SECRETS_KEY → 32-byte AES-256 金鑰材料。 */
function keyMaterial(secretsKey: string): Uint8Array<ArrayBuffer> {
  if (!secretsKey) throw new Error("SECRETS_KEY not configured");
  let decoded: string;
  try {
    decoded = atob(secretsKey);
  } catch (e) {
    throw new Error(
      "SECRETS_KEY must be a base64-encoded 32-byte AES-256 key",
      { cause: e },
    );
  }
  const material = fromBinary(decoded);
  if (material.byteLength !== 32) {
    throw new Error("SECRETS_KEY must be a base64-encoded 32-byte AES-256 key");
  }
  return material;
}

async function importAesKey(secretsKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    keyMaterial(secretsKey),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * 02 §1 硬規則:每次寫入都用 crypto.getRandomValues 產生全新 12-byte IV,
 * IV 前置於密文,整體 base64 回傳。
 *
 * @param secretsKey base64 的 SECRETS_KEY(呼叫端自行從 env 取)。
 */
export async function encryptSecretWithKey(
  secretsKey: string,
  plaintext: string,
): Promise<string> {
  const key = await importAesKey(secretsKey);
  const iv = crypto.getRandomValues(bytes(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc(plaintext)),
  );
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv, 0);
  combined.set(ct, iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * encryptSecretWithKey 的逆運算。密文被竄改 / 金鑰不符 → crypto.subtle.decrypt throw
 * (呼叫端自行決定 fail-loud 或降級)。
 *
 * @param secretsKey base64 的 SECRETS_KEY(呼叫端自行從 env 取)。
 */
export async function decryptSecretWithKey(
  secretsKey: string,
  stored: string,
): Promise<string> {
  const key = await importAesKey(secretsKey);
  const combined = fromBinary(atob(stored));
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}
