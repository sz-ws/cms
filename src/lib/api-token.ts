import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "./db";
import { apiTokens } from "./schema";

// roadmap #1:Public Content API 的 inbound bearer-token 認證。
//
// 這條認證線刻意與 cookie session(src/lib/auth.ts)分離:token 是給「外部程式」用的
// 長效 bearer 憑證,不做 Origin 檢查(bearer 本身即憑證,無 CSRF 面);而 session 是
// 瀏覽器 cookie,mutation 必須 Origin 檢查。兩者的共通點是 hash 手法 —— 同樣只在 D1
// 存 SHA-256(raw) 的 hex,raw 值永不落庫(見 auth.ts 的 session hashToken 慣例)。

/** v1 只有 read scope(欄位預留未來擴充)。 */
export interface ApiTokenIdentity {
  id: string;
  name: string;
  scope: "read";
}

// ---- byte / hex helpers(以 ArrayBuffer 為 backing,對齊 auth.ts / settings.ts)----

function bytes(len: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(len));
}

function enc(s: string): Uint8Array<ArrayBuffer> {
  const src = new TextEncoder().encode(s);
  const out = bytes(src.length);
  out.set(src);
  return out;
}

const toHex = (u8: Uint8Array): string =>
  Array.from(u8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** base64url(無 padding)—— token body 用;URL-safe 且不含需跳脫字元。 */
function base64url(u8: Uint8Array): string {
  return btoa(String.fromCharCode(...u8))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** SHA-256(token) 的 hex(D1 只存這個;與 session hashToken 同手法)。 */
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc(token));
  return toHex(new Uint8Array(digest));
}

// last_used_at 節流:距上次 > 60s 才寫,避免每讀一次就寫一次 D1。
const LAST_USED_THROTTLE_MS = 60_000;

// token 格式:sk_ + 32 bytes base64url。prefix = 前 11 字元("sk_" + 8)。
const TOKEN_PREFIX = "sk_";
const PREFIX_LEN = TOKEN_PREFIX.length + 8;

/**
 * 讀 Authorization: Bearer <raw> → SHA-256 → 查 api_tokens.token_hash。
 * 命中回 identity,否則 null。成功時節流更新 last_used_at(> 60s 才寫)。
 */
export async function authenticateApiToken(
  req: Request,
): Promise<ApiTokenIdentity | null> {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw) return null;

  const tokenHash = await hashToken(raw);
  const rows = await db()
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      scope: apiTokens.scope,
      lastUsedAt: apiTokens.lastUsedAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const now = Date.now();
  if (row.lastUsedAt === null || now - row.lastUsedAt > LAST_USED_THROTTLE_MS) {
    // 節流寫入:失敗不影響認證結果(讀路徑不因 last_used 記帳而壞掉)。
    try {
      await db()
        .update(apiTokens)
        .set({ lastUsedAt: now })
        .where(eq(apiTokens.id, row.id));
    } catch (e) {
      console.error("[api-token] last_used_at update failed", e);
    }
  }

  return { id: row.id, name: row.name, scope: "read" };
}

/**
 * 建 token:回傳 { raw, id, prefix }。raw 只此一次回傳,內部只存 hash + prefix。
 */
export async function createApiToken(
  name: string,
): Promise<{ raw: string; id: string; prefix: string }> {
  const raw = TOKEN_PREFIX + base64url(crypto.getRandomValues(bytes(32)));
  const prefix = raw.slice(0, PREFIX_LEN);
  const tokenHash = await hashToken(raw);
  const id = nanoid();
  const now = Date.now();
  await db().insert(apiTokens).values({
    id,
    name,
    tokenHash,
    prefix,
    scope: "read",
    lastUsedAt: null,
    createdAt: now,
  });
  return { raw, id, prefix };
}

export interface ApiTokenListItem {
  id: string;
  name: string;
  prefix: string;
  scope: string;
  lastUsedAt: number | null;
  createdAt: number;
}

/** 列出 tokens(絕不含 hash 或 raw)。 */
export async function listApiTokens(): Promise<ApiTokenListItem[]> {
  return db()
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      prefix: apiTokens.prefix,
      scope: apiTokens.scope,
      lastUsedAt: apiTokens.lastUsedAt,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .orderBy(apiTokens.createdAt);
}

/** 撤銷(刪除)某 token。撤銷後該 raw token 立即 401。 */
export async function revokeApiToken(id: string): Promise<void> {
  await db().delete(apiTokens).where(eq(apiTokens.id, id));
}
