import { and, eq, lt, notExists } from "drizzle-orm";
import { db } from "../db";
import { mcpClients, mcpGrants } from "../schema";
import { timingSafeEqualString } from "../security";
import { TOKEN_PREFIX, hashToken, randomToken } from "./crypto";

// AI App 的動態登記(RFC 7591)。MCP 授權規格要 client 能自己登記:使用者在 Claude 或
// ChatGPT 貼上網址之後,App 自己來這裡報名字與回呼網址,不需要任何人先建帳。
//
// 登記是公開的,所以這裡的每一條規則都假設送來的人不懷好意:
//   * 回呼網址只收「絕對網址、無 fragment」,http 只給 loopback(本機 App 用);
//     javascript:/data: 之類能在瀏覽器裡執行或讀檔的 scheme 一律拒收。之後的授權請求
//     只接受**登記過的**網址逐字相等(loopback 例外見 redirectUriMatches)——
//     這一條是整個流程防 open redirect 的唯一依據。
//   * 名字只是名字:會出現在同意畫面與後台清單上,但畫面同時顯示「允許後回到哪個
//     網域」,管理員看得到一個自稱 Claude 的 App 其實要回到別處。
//   * 沒有任何人允許過的登記,一週後在下一次登記時順手清掉(沒有 cron)。

/** 一個 App 最多登記幾個回呼網址、每個多長。實際 App 都只有一兩個。 */
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2_000;
const MAX_CLIENT_NAME_LENGTH = 100;
/** 沒人允許過的登記留多久。 */
const ABANDONED_CLIENT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 不收的 scheme:在瀏覽器裡會執行程式、讀本機檔案,或根本不是導向目標的東西。
 * 其餘的私有 scheme(cursor://、com.example.app:/…)照 RFC 8252 §7.1 收下 —— 那是原生
 * App 接回呼的正規方式,它們開不了網頁,也就當不成 open redirect;授權碼被別的 App
 * 攔走的風險由 PKCE 擋(拿不到 verifier 換不到權杖)。
 */
const BLOCKED_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
  "about:",
  "filesystem:",
  "ftp:",
  "ws:",
  "wss:",
  "chrome:",
  "view-source:",
]);

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** 一個回呼網址能不能登記(見檔頭)。 */
export function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REDIRECT_URI_LENGTH) {
    return false;
  }
  // 空白與控制字元:URL parser 會悄悄修掉,修完的樣子就不是登記時看到的樣子。
  if (/[\s\x00-\x1f\x7f]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || value.includes("#")) return false;
  if (url.username || url.password) return false;
  if (BLOCKED_SCHEMES.has(url.protocol)) return false;
  if (url.protocol === "https:") return url.hostname.length > 0;
  if (url.protocol === "http:") return isLoopbackHostname(url.hostname);
  // 私有 scheme:至少要有 scheme 以外的東西。
  return value.length > url.protocol.length + 1;
}

/**
 * 授權請求帶來的 redirect_uri 對不對得上登記。逐字相等;唯一的例外是 http loopback:
 * 本機 App 每次啟動拿到的連接埠可能不同,RFC 8252 §7.3 要求授權伺服器接受任何連接埠
 * (scheme、主機、路徑、查詢字串仍要逐字相同)。
 */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let want: URL;
  try {
    want = new URL(requested);
  } catch {
    return false;
  }
  if (want.protocol !== "http:" || !isLoopbackHostname(want.hostname)) return false;
  return registered.some((raw) => {
    try {
      const have = new URL(raw);
      return (
        have.protocol === "http:" &&
        have.hostname === want.hostname &&
        have.pathname === want.pathname &&
        have.search === want.search
      );
    } catch {
      return false;
    }
  });
}

export type TokenEndpointAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

export interface RegistrationInput {
  name: string;
  redirectUris: string[];
  authMethod: TokenEndpointAuthMethod;
}

export type RegistrationParse =
  | { ok: true; value: RegistrationInput }
  | { ok: false; error: "invalid_redirect_uri" | "invalid_client_metadata"; description: string };

/**
 * RFC 7591 §2 的 client metadata → 我們要存的形狀。只認用得到的欄位,其餘(logo_uri、
 * client_uri…)忽略:畫面上不顯示 App 自報的圖片或連結。
 */
export function parseRegistration(body: Record<string, unknown>): RegistrationParse {
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return { ok: false, error: "invalid_redirect_uri", description: "redirect_uris must list 1 to 10 URIs." };
  }
  for (const uri of uris) {
    if (!isAllowedRedirectUri(uri)) {
      return {
        ok: false,
        error: "invalid_redirect_uri",
        description: "Each redirect URI must be absolute without a fragment; http is only allowed for loopback hosts.",
      };
    }
  }

  const rawMethod = body.token_endpoint_auth_method;
  // RFC 7591 §2:沒寫就是 client_secret_basic。
  const authMethod = rawMethod === undefined ? "client_secret_basic" : rawMethod;
  if (authMethod !== "none" && authMethod !== "client_secret_post" && authMethod !== "client_secret_basic") {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description: "token_endpoint_auth_method must be none, client_secret_post or client_secret_basic.",
    };
  }

  const grantTypes = body.grant_types;
  if (
    grantTypes !== undefined &&
    (!Array.isArray(grantTypes) ||
      !grantTypes.every((g) => g === "authorization_code" || g === "refresh_token"))
  ) {
    return { ok: false, error: "invalid_client_metadata", description: "Only authorization_code and refresh_token are supported." };
  }
  const responseTypes = body.response_types;
  if (responseTypes !== undefined && (!Array.isArray(responseTypes) || !responseTypes.every((r) => r === "code"))) {
    return { ok: false, error: "invalid_client_metadata", description: "Only the code response type is supported." };
  }

  const rawName = body.client_name;
  if (rawName !== undefined && typeof rawName !== "string") {
    return { ok: false, error: "invalid_client_metadata", description: "client_name must be a string." };
  }
  // 控制字元換成空白、壓掉連續空白:名字會原樣出現在同意畫面上。
  const name = (rawName ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_CLIENT_NAME_LENGTH);

  return { ok: true, value: { name, redirectUris: uris as string[], authMethod } };
}

export interface RegisteredClient {
  clientId: string;
  /** 只在 confidential client 登記的那一次回應裡出現。 */
  clientSecret?: string;
  issuedAt: number;
}

export async function registerClient(input: RegistrationInput, now: number): Promise<RegisteredClient> {
  const clientId = randomToken(TOKEN_PREFIX.client, 16);
  const clientSecret = input.authMethod === "none" ? undefined : randomToken(TOKEN_PREFIX.secret);
  await db()
    .insert(mcpClients)
    .values({
      id: clientId,
      name: input.name,
      redirectUris: JSON.stringify(input.redirectUris),
      secretHash: clientSecret ? await hashToken(clientSecret) : null,
      createdAt: now,
    });
  return { clientId, ...(clientSecret ? { clientSecret } : {}), issuedAt: now };
}

export interface McpClient {
  id: string;
  name: string;
  redirectUris: string[];
  secretHash: string | null;
}

function parseUris(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export async function getClient(clientId: unknown): Promise<McpClient | null> {
  if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 200) return null;
  const rows = await db().select().from(mcpClients).where(eq(mcpClients.id, clientId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    redirectUris: parseUris(row.redirectUris),
    secretHash: row.secretHash,
  };
}

/**
 * client 認證:公開 client(沒有 secret)不需要;confidential client 一定要帶對的 secret。
 * 雜湊後 constant-time 比對。
 */
export async function clientSecretOk(client: McpClient, presented: string | null): Promise<boolean> {
  if (client.secretHash === null) return true;
  if (!presented) return false;
  return timingSafeEqualString(await hashToken(presented), client.secretHash);
}

/** 登記超過一週、沒有任何連線的 App 登記。best-effort,失敗不擋登記。 */
export async function pruneAbandonedClients(now: number): Promise<void> {
  try {
    await db()
      .delete(mcpClients)
      .where(
        and(
          lt(mcpClients.createdAt, now - ABANDONED_CLIENT_MS),
          notExists(
            db().select({ id: mcpGrants.id }).from(mcpGrants).where(eq(mcpGrants.clientId, mcpClients.id)),
          ),
        ),
      );
  } catch (e) {
    console.error("[mcp] pruning abandoned clients failed", e);
  }
}
