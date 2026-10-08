// spec-login-providers.md §5:id_token(JWT)的驗證,從 oidc.ts 拆出來的那一段。
//
// oidc.ts 管流程(discovery、state、token 交換、帳號);這裡只做一件事:拿到 JWT、JWKS 與預期的
// iss / aud / nonce,用 WebCrypto 驗簽章與 claims。沒有網路、沒有資料庫。
// 兩個檔共用的小東西(OidcError、Jwk、bytes、encUtf8、normalizeIssuer)也放在這裡,由 oidc.ts import;
// 這個檔不 import oidc.ts。別的地方照舊從 "@/lib/oidc" 拿 verifyJwt(oidc.ts 重新匯出)。

export interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  [k: string]: unknown;
}

/** 引擎內部錯誤:message 為機器可讀 code(絕不含 secret / 上游 body 全文)。 */
export class OidcError extends Error {}

// ---- base64url / bytes helpers ----

export function bytes(len: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(len));
}
export function encUtf8(s: string): Uint8Array<ArrayBuffer> {
  const src = new TextEncoder().encode(s);
  const out = bytes(src.length);
  out.set(src);
  return out;
}
function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = bytes(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlDecodeToString(s: string): string {
  return new TextDecoder().decode(b64urlDecode(s));
}

export function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, "");
}

// ---- id_token 驗證(alg allowlist + JWKS 簽章 + claims)----

interface IdTokenClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

const VERIFY_ALG: Record<string, { import: EcKeyImportParams | RsaHashedImportParams; verify: EcdsaParams | AlgorithmIdentifier }> = {
  RS256: {
    import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verify: { name: "RSASSA-PKCS1-v1_5" },
  },
  ES256: {
    import: { name: "ECDSA", namedCurve: "P-256" },
    verify: { name: "ECDSA", hash: "SHA-256" },
  },
};

/** HS256:金鑰就是 client secret 本身(OIDC Core §10.1)。驗證用 WebCrypto 的 HMAC verify(比對時間固定)。 */
async function verifyHs256(secret: string, sig: Uint8Array<ArrayBuffer>, signed: Uint8Array<ArrayBuffer>): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", encUtf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("HMAC", key, sig, signed);
  } catch {
    return false;
  }
}

/**
 * 驗 JWT:alg allowlist、JWKS 簽章、iss、aud、exp;給了 nonce 就一併比對(OIDC 一定給;
 * Firebase 的 ID token 沒有 nonce,freshness 由 firebase-login.ts 看 auth_time)。
 * 回傳整理過的 claims 與原始 payload(呼叫端要再看其他 claim 時用)。
 *
 * 1.76.0 HS256:只有呼叫端給了 clientSecret 才收,而且只拿那個字串當金鑰,絕不拿 JWKS 裡公開的金鑰
 * (那是演算法混淆的洞)。授權碼流程(completeOAuth)會給:id_token 是我們自己向 token endpoint 換來的,
 * 對方用我們的 client secret 簽。LINE 的網頁登入就是這樣(它的 discovery 只寫 ES256,那是 App 與 LIFF 的);
 * 以前不收 HS256,LINE 網頁登入每一次都在這裡失敗。只信公開金鑰的呼叫端(Firebase)不給,HS256 照舊不收。
 */
export async function verifyJwt(
  idToken: string,
  jwks: Jwk[],
  expected: { issuer: string; audience: string; nonce?: string; clientSecret?: string },
): Promise<{ claims: IdTokenClaims; payload: Record<string, unknown> }> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OidcError("idtoken_malformed");
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(b64urlDecodeToString(headerB64));
    payload = JSON.parse(b64urlDecodeToString(payloadB64));
  } catch {
    throw new OidcError("idtoken_malformed");
  }

  const algName = header.alg ?? "";
  const signed = encUtf8(`${headerB64}.${payloadB64}`);
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = b64urlDecode(sigB64);
  } catch {
    throw new OidcError("idtoken_malformed");
  }
  let verified = false;
  if (algName === "HS256") {
    if (!expected.clientSecret) throw new OidcError("unsupported_alg");
    verified = await verifyHs256(expected.clientSecret, sig, signed);
  } else {
    if (!Object.hasOwn(VERIFY_ALG, algName)) throw new OidcError("unsupported_alg");
    const alg = VERIFY_ALG[algName];

    // 依 kid 選 key(無 kid 時取第一把符合 kty 的);import → verify 簽章。
    const wantKty = algName === "RS256" ? "RSA" : "EC";
    const candidates = jwks.filter(
      (k) => k.kty === wantKty && (header.kid ? k.kid === header.kid : true),
    );
    if (candidates.length === 0) throw new OidcError("jwks_no_matching_key");

    for (const jwk of candidates) {
      try {
        const key = await crypto.subtle.importKey("jwk", jwk, alg.import, false, [
          "verify",
        ]);
        if (await crypto.subtle.verify(alg.verify, key, sig, signed)) {
          verified = true;
          break;
        }
      } catch {
        // 這把 key import/verify 失敗 → 試下一把。
      }
    }
  }
  if (!verified) throw new OidcError("idtoken_bad_signature");

  // claims 驗證:iss 一致、aud === audience、exp > now-60s、nonce 相符。
  if (normalizeIssuer(String(payload.iss ?? "")) !== normalizeIssuer(expected.issuer)) {
    throw new OidcError("idtoken_bad_iss");
  }
  const aud = payload.aud;
  const audOk = Array.isArray(aud)
    ? aud.includes(expected.audience)
    : aud === expected.audience;
  if (!audOk) throw new OidcError("idtoken_bad_aud");
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  if (exp * 1000 <= Date.now() - 60_000) throw new OidcError("idtoken_expired");
  if (expected.nonce !== undefined && payload.nonce !== expected.nonce) {
    throw new OidcError("idtoken_bad_nonce");
  }

  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0) throw new OidcError("idtoken_no_sub");

  const claims: IdTokenClaims = {
    sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    email_verified:
      typeof payload.email_verified === "boolean" ? payload.email_verified : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined,
    picture: typeof payload.picture === "string" ? payload.picture : undefined,
  };
  return { claims, payload };
}
