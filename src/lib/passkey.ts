// L1 §2:passkey(WebAuthn)核心邏輯。包住 @simplewebauthn/server,對外只暴露四個
// 函式(對應四支 API)。RP 參數一律由 request 推導,不設 config:
//   rpID = new URL(req.url).hostname、expectedOrigin = new URL(req.url).origin。
// → 部署到任何網域零設定;localhost dev 天然可用。
//
// DB 存取全走 raw getDB()(同 rate-limit.ts):challenge 單次消費需要 meta.changes,
// raw D1 最直接。tests 以 vi.mock("@/lib/cf") 讓 getDB 回傳 cloudflare:test 的 env.DB。
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import { getDB } from "./cf";
import { getSetting } from "./settings";
import type { SessionUser } from "./auth";

/** verify / lookup 任何一步失敗都 throw 這個;route 統一轉 401/400。 */
export class PasskeyError extends Error {
  constructor() {
    super("passkey_failed");
  }
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 分鐘(L1 §1)

// ---- base64url helpers(以 ArrayBuffer 為 backing,對齊 lib 的 Uint8Array_ = Uint8Array<ArrayBuffer>)----

function b64uEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
  const bin = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeUserId(id: string): Uint8Array<ArrayBuffer> {
  const src = new TextEncoder().encode(id);
  const out = new Uint8Array(new ArrayBuffer(src.length));
  out.set(src);
  return out;
}

// ---- challenge 表存取 ----

async function insertChallenge(
  challenge: string,
  kind: "register" | "auth",
  userId: string | null,
): Promise<void> {
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  await getDB()
    .prepare(
      "INSERT INTO webauthn_challenges (id, kind, user_id, expires_at) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(challenge, kind, userId, expiresAt)
    .run();
}

/**
 * 單次消費 challenge(L1 §1):條件式 DELETE WHERE id=? AND kind=? AND expires_at>now,
 * meta.changes===0 → false(過期/重放/未知皆走此路,呼叫端轉 401)。順手刪除過期列。
 */
async function consumeChallenge(
  challenge: string,
  kind: "register" | "auth",
): Promise<boolean> {
  const now = Date.now();
  await getDB()
    .prepare("DELETE FROM webauthn_challenges WHERE expires_at < ?1")
    .bind(now)
    .run();
  const res = await getDB()
    .prepare(
      "DELETE FROM webauthn_challenges WHERE id = ?1 AND kind = ?2 AND expires_at > ?3",
    )
    .bind(challenge, kind, now)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// ---- response 解析 helpers ----

/** 從 response 的 clientDataJSON(base64url JSON)取出 challenge —— 作為 DB 查詢 key。 */
function extractChallenge(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const resp = (body as { response?: { clientDataJSON?: unknown } }).response;
  const cdj = resp?.clientDataJSON;
  if (typeof cdj !== "string") return null;
  try {
    const json = new TextDecoder().decode(b64uDecode(cdj));
    const parsed = JSON.parse(json) as { challenge?: unknown };
    return typeof parsed.challenge === "string" ? parsed.challenge : null;
  } catch {
    return null;
  }
}

function extractCredentialId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** name:優先 body.name(使用者取的標籤),否則由 User-Agent 推斷(如 "Chrome on Mac")。 */
function deriveName(body: unknown, req: Request): string {
  if (body && typeof body === "object") {
    const n = (body as { name?: unknown }).name;
    if (typeof n === "string" && n.trim()) return n.trim().slice(0, 60);
  }
  return inferNameFromUA(req.headers.get("user-agent"));
}

function inferNameFromUA(ua: string | null): string {
  if (!ua) return "Passkey";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const os = /Mac OS X|Macintosh/.test(ua)
    ? "Mac"
    : /Windows/.test(ua)
      ? "Windows"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad|iPod/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "device";
  return `${browser} on ${os}`;
}

// ---- 四個對外函式 ----

export async function startRegistration(
  user: SessionUser,
  req: Request,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const url = new URL(req.url);
  const rpName = await getSetting<string>("core.siteTitle", "My Site");

  // excludeCredentials:該 user 現有 passkeys(防重複註冊同一把)。
  const existing = await getDB()
    .prepare("SELECT id, transports FROM passkeys WHERE user_id = ?1")
    .bind(user.id)
    .all<{ id: string; transports: string | null }>();
  const excludeCredentials = existing.results.map((r) => ({
    id: r.id,
    transports: r.transports
      ? (JSON.parse(r.transports) as AuthenticatorTransportFuture[])
      : undefined,
  }));

  const options = await generateRegistrationOptions({
    rpName,
    rpID: url.hostname,
    userName: user.email,
    userID: encodeUserId(user.id),
    userDisplayName: user.name,
    attestationType: "none",
    excludeCredentials,
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "preferred",
    },
  });

  await insertChallenge(options.challenge, "register", user.id);
  return options;
}

export async function finishRegistration(
  user: SessionUser,
  req: Request,
  body: unknown,
): Promise<{ id: string; name: string }> {
  const challenge = extractChallenge(body);
  if (!challenge) throw new PasskeyError();
  if (!(await consumeChallenge(challenge, "register"))) throw new PasskeyError();

  const url = new URL(req.url);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: url.origin,
      expectedRPID: url.hostname,
      // options 用 userVerification:"preferred",故 verify 不硬性要求 UV(否則與 preferred 矛盾)。
      requireUserVerification: false,
    });
  } catch {
    throw new PasskeyError();
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw new PasskeyError();
  }

  const { credential } = verification.registrationInfo;
  const name = deriveName(body, req);
  const transports = credential.transports
    ? JSON.stringify(credential.transports)
    : null;

  await getDB()
    .prepare(
      "INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
    )
    .bind(
      credential.id,
      user.id,
      b64uEncode(credential.publicKey),
      credential.counter,
      transports,
      name,
      Date.now(),
    )
    .run();

  return { id: credential.id, name };
}

export async function startAuthentication(
  req: Request,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const url = new URL(req.url);
  const options = await generateAuthenticationOptions({
    rpID: url.hostname,
    userVerification: "preferred",
    // usernameless:不帶 allowCredentials,由 client 讓使用者挑 resident key。
  });
  await insertChallenge(options.challenge, "auth", null);
  return options;
}

interface PasskeyAuthRow {
  id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  user_id: string;
  email: string;
  name: string;
  role: string;
  avatar_key: string | null;
}

/**
 * D1 的 role 欄位型別是 text —— 型別系統管不到它,所以進到 SessionUser 之前
 * 必須自己收斂。認不得的值一律當 guest(最小權限),而不是預設 editor:
 * 未知的值代表資料異常或 schema 漂移,那種時候給多不給少是錯的方向。
 */
function normalizeRole(role: string): SessionUser["role"] {
  return role === "admin" || role === "editor" || role === "guest"
    ? role
    : "guest";
}

export async function finishAuthentication(
  req: Request,
  body: unknown,
): Promise<SessionUser> {
  const challenge = extractChallenge(body);
  if (!challenge) throw new PasskeyError();
  if (!(await consumeChallenge(challenge, "auth"))) throw new PasskeyError();

  const credId = extractCredentialId(body);
  if (!credId) throw new PasskeyError();

  const row = await getDB()
    .prepare(
      `SELECT p.id AS id, p.public_key AS public_key, p.counter AS counter,
              p.transports AS transports, u.id AS user_id, u.email AS email,
              u.name AS name, u.role AS role, u.avatar_key AS avatar_key
       FROM passkeys p INNER JOIN users u ON u.id = p.user_id
       WHERE p.id = ?1`,
    )
    .bind(credId)
    .first<PasskeyAuthRow>();
  if (!row) throw new PasskeyError();

  const url = new URL(req.url);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: url.origin,
      expectedRPID: url.hostname,
      requireUserVerification: false,
      credential: {
        id: row.id,
        publicKey: b64uDecode(row.public_key),
        counter: row.counter,
        transports: row.transports
          ? (JSON.parse(row.transports) as AuthenticatorTransportFuture[])
          : undefined,
      },
    });
  } catch {
    throw new PasskeyError();
  }
  if (!verification.verified) throw new PasskeyError();

  // Counter 規則(L1 §2):lib 回的 newCounter 直接寫回;不做 counter 回退硬拒
  // —— passkey 生態 counter 恆 0 的裝置很多,硬拒會誤殺合法使用者。
  await getDB()
    .prepare("UPDATE passkeys SET counter = ?1, last_used_at = ?2 WHERE id = ?3")
    .bind(verification.authenticationInfo.newCounter, Date.now(), row.id)
    .run();

  return {
    id: row.user_id,
    email: row.email,
    name: row.name,
    // 忠實還原 D1 裡的 role。原本寫的是 `row.role === "admin" ? "admin" : "editor"`,
    // 於是 guest 會在這裡被升成 editor。今天沒有造成越權 —— session 在下一個
    // request 會重新從 D1 讀真正的 role,把它蓋回去 —— 但那是「另一段程式碼剛好
    // 補救了」,不是這裡對。只要有任何路徑在同一個 request 內拿這個回傳值做授權
    // 判斷,它就直接是越權。認得的三個值原樣傳回,認不得的才退回最小權限。
    role: normalizeRole(row.role),
    avatarKey: row.avatar_key,
  };
}
