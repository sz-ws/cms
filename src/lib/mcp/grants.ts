import { and, desc, eq, lt, lte, notExists } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db } from "../db";
import { mcpClients, mcpCodes, mcpGrants, mcpTokens, users } from "../schema";
import { isFullAdmin, type SessionUser } from "../auth";
import { TOKEN_PREFIX, hashToken, randomToken, verifyPkce } from "./crypto";
import type { McpScope } from "./site";

// 連線(grant)、授權碼與權杖。整個 AI 連線的「誰可以用誰的身分做什麼」都在這一檔。
//
// ── 誰能連線 ────────────────────────────────────────────────────────────────
// 只有真正的管理員(isFullAdmin)。後台助理本來就是 admin-only(spec-admin-agent §1.1,
// 不可協商),而 MCP 交出去的是**同一份** tool 清單 —— 它讀得到草稿、投稿者的個資、
// 訂單的收件地址。編輯、會員、自訂角色都不行;自訂角色的授權是逐頁的,而 tool 不對應
// 任何一頁。規則集中在 connectPolicy(),同意畫面、換權杖、每一次 MCP 呼叫都問它:
// 管理員哪天被降級,他授權過的連線在下一次呼叫就失效,不必等權杖過期。
//
// ── 壽命 ────────────────────────────────────────────────────────────────────
// 授權碼 5 分鐘、一次性(DELETE … RETURNING 取走,重放拿到的是空的)。access 一小時;
// refresh 30 天,每用一次就換一把新的、舊的當場刪掉(rotation)—— 被偷的 refresh 最多
// 用一次,之後合法的 App 會發現自己的被換掉而要求重新連線。

const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 同意之後一天內還沒換到權杖的連線,在下次清理時移除。 */
const UNFINISHED_GRANT_MS = 24 * 60 * 60 * 1000;
/** last_used_at 節流:距上次 > 60s 才寫(同 api-token)。 */
const LAST_USED_THROTTLE_MS = 60_000;

export interface ConnectPolicy {
  connect: boolean;
  write: boolean;
}

/** 這個人能不能連線、能不能給「可以修改」。見檔頭。 */
export function connectPolicy(user: Pick<SessionUser, "role" | "staffRole"> | null): ConnectPolicy {
  const admin = isFullAdmin(user);
  return { connect: admin, write: admin };
}

function scopeString(scope: McpScope): string {
  return scope === "write" ? "read write" : "read";
}

// ---- 同意 → 授權碼 ----

export interface ApproveInput {
  clientId: string;
  userId: string;
  scope: McpScope;
  resource: string;
  redirectUri: string;
  codeChallenge: string;
}

/**
 * 管理員按下「允許」:建立(或更新)連線,發一個授權碼。回傳原始碼(只出現在導回 App
 * 的網址上一次)。同一個 App 同一位管理員已有連線 → 更新權限與時間,不多開一條。
 */
export async function approveGrant(input: ApproveInput, now: number): Promise<string> {
  const upserted = await db()
    .insert(mcpGrants)
    .values({
      id: crypto.randomUUID(),
      clientId: input.clientId,
      userId: input.userId,
      scope: input.scope,
      resource: input.resource,
      createdAt: now,
      lastUsedAt: null,
    })
    .onConflictDoUpdate({
      target: [mcpGrants.clientId, mcpGrants.userId],
      set: { scope: input.scope, resource: input.resource, createdAt: now },
    })
    .returning({ id: mcpGrants.id });
  const grantId = upserted[0]?.id;
  if (!grantId) throw new Error("[mcp] grant upsert returned no row");

  const code = randomToken(TOKEN_PREFIX.code);
  await db()
    .insert(mcpCodes)
    .values({
      codeHash: await hashToken(code),
      grantId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      expiresAt: now + CODE_TTL_MS,
    });
  await pruneStale(now);
  return code;
}

// ---- 權杖 ----

export interface TokenSet {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export type TokenResult =
  | { ok: true; tokens: TokenSet }
  | { ok: false; error: "invalid_grant" | "invalid_target"; description: string };

function grantError(description: string): TokenResult {
  return { ok: false, error: "invalid_grant", description };
}

/** 發一組 access + refresh,順手刪掉這條連線已過期的權杖。 */
async function issueTokens(grantId: string, scope: McpScope, now: number): Promise<TokenSet> {
  const access = randomToken(TOKEN_PREFIX.access);
  const refresh = randomToken(TOKEN_PREFIX.refresh);
  const batch: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    db()
      .insert(mcpTokens)
      .values([
        { tokenHash: await hashToken(access), grantId, kind: "access", expiresAt: now + ACCESS_TTL_MS, createdAt: now },
        { tokenHash: await hashToken(refresh), grantId, kind: "refresh", expiresAt: now + REFRESH_TTL_MS, createdAt: now },
      ]),
    db()
      .delete(mcpTokens)
      .where(and(eq(mcpTokens.grantId, grantId), lte(mcpTokens.expiresAt, now))),
  ];
  await db().batch(batch);
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refresh,
    scope: scopeString(scope),
  };
}

interface GrantOwner {
  id: string;
  clientId: string;
  scope: McpScope;
  resource: string;
  userRole: SessionUser["role"];
  staffRoleId: string | null;
}

async function loadGrant(grantId: string): Promise<GrantOwner | null> {
  const rows = await db()
    .select({
      id: mcpGrants.id,
      clientId: mcpGrants.clientId,
      scope: mcpGrants.scope,
      resource: mcpGrants.resource,
      userRole: users.role,
      staffRoleId: users.staffRoleId,
    })
    .from(mcpGrants)
    .innerJoin(users, eq(users.id, mcpGrants.userId))
    .where(eq(mcpGrants.id, grantId))
    .limit(1);
  return rows[0] ?? null;
}

/** 允許這條連線的管理員現在還是不是管理員(見檔頭)。 */
function ownerStillAllowed(grant: GrantOwner): boolean {
  return connectPolicy({
    role: grant.userRole,
    staffRole: grant.staffRoleId ? { id: grant.staffRoleId, name: "" } : null,
  }).connect;
}

export interface RedeemInput {
  code: string;
  clientId: string;
  redirectUri: string | null;
  codeVerifier: unknown;
  /** 換權杖時又帶了 resource 就要跟授權時的一樣(已正規化;null = 沒帶)。 */
  resource: string | null;
}

/** grant_type=authorization_code。 */
export async function redeemCode(input: RedeemInput, now: number): Promise<TokenResult> {
  // 先取走再驗:不管後面哪一步失敗,這個碼都已經用掉了 —— 猜 verifier 只有一次機會。
  const taken = await db()
    .delete(mcpCodes)
    .where(eq(mcpCodes.codeHash, await hashToken(input.code)))
    .returning();
  const code = taken[0];
  if (!code || code.expiresAt <= now) return grantError("The authorization code is invalid or expired.");

  const grant = await loadGrant(code.grantId);
  if (!grant || grant.clientId !== input.clientId) {
    return grantError("The authorization code was not issued to this client.");
  }
  // OAuth 2.1 §4.1.3:授權請求帶了 redirect_uri,這裡就要帶一樣的。
  if (input.redirectUri !== null && input.redirectUri !== code.redirectUri) {
    return grantError("redirect_uri does not match the authorization request.");
  }
  if (!(await verifyPkce(input.codeVerifier, code.codeChallenge))) {
    return grantError("PKCE verification failed.");
  }
  if (input.resource !== null && input.resource !== grant.resource) {
    return { ok: false, error: "invalid_target", description: "resource does not match the authorization request." };
  }
  if (!ownerStillAllowed(grant)) return grantError("The account that approved this connection can no longer connect apps.");
  return { ok: true, tokens: await issueTokens(grant.id, grant.scope, now) };
}

export interface RefreshInput {
  refreshToken: string;
  clientId: string;
  resource: string | null;
}

/** grant_type=refresh_token,含 rotation(見檔頭)。 */
export async function refreshGrant(input: RefreshInput, now: number): Promise<TokenResult> {
  const taken = await db()
    .delete(mcpTokens)
    .where(and(eq(mcpTokens.tokenHash, await hashToken(input.refreshToken)), eq(mcpTokens.kind, "refresh")))
    .returning({ grantId: mcpTokens.grantId, expiresAt: mcpTokens.expiresAt });
  const row = taken[0];
  if (!row || row.expiresAt <= now) return grantError("The refresh token is invalid or expired.");

  const grant = await loadGrant(row.grantId);
  if (!grant || grant.clientId !== input.clientId) {
    return grantError("The refresh token was not issued to this client.");
  }
  if (input.resource !== null && input.resource !== grant.resource) {
    return { ok: false, error: "invalid_target", description: "resource does not match this connection." };
  }
  if (!ownerStillAllowed(grant)) return grantError("The account that approved this connection can no longer connect apps.");
  return { ok: true, tokens: await issueTokens(grant.id, grant.scope, now) };
}

// ---- MCP 呼叫時的驗證 ----

export interface McpCaller {
  grantId: string;
  scope: McpScope;
  resource: string;
  /** App 的名字(登記時自報;空字串 = 沒報)。 */
  app: string;
  /** 以這位管理員的身分執行 tool。 */
  user: SessionUser;
}

/** Authorization 標頭 → bearer 原值;不是 Bearer 就是 null。 */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * access token → 呼叫者。過期、連線被撤銷、允許它的人已不是管理員,都是 null。
 * 成功時節流更新 last_used_at(設定頁的「最近使用」)。
 */
export async function authenticateAccessToken(raw: string, now: number): Promise<McpCaller | null> {
  const rows = await db()
    .select({
      expiresAt: mcpTokens.expiresAt,
      grantId: mcpGrants.id,
      scope: mcpGrants.scope,
      resource: mcpGrants.resource,
      lastUsedAt: mcpGrants.lastUsedAt,
      app: mcpClients.name,
      userId: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      avatarKey: users.avatarKey,
      staffRoleId: users.staffRoleId,
    })
    .from(mcpTokens)
    .innerJoin(mcpGrants, eq(mcpGrants.id, mcpTokens.grantId))
    .innerJoin(mcpClients, eq(mcpClients.id, mcpGrants.clientId))
    .innerJoin(users, eq(users.id, mcpGrants.userId))
    .where(and(eq(mcpTokens.tokenHash, await hashToken(raw)), eq(mcpTokens.kind, "access")))
    .limit(1);
  const row = rows[0];
  if (!row || row.expiresAt <= now) return null;
  const staffRole = row.staffRoleId ? { id: row.staffRoleId, name: "" } : null;
  if (!connectPolicy({ role: row.role, staffRole }).connect) return null;

  if (row.lastUsedAt === null || now - row.lastUsedAt > LAST_USED_THROTTLE_MS) {
    try {
      await db().update(mcpGrants).set({ lastUsedAt: now }).where(eq(mcpGrants.id, row.grantId));
    } catch (e) {
      // 記帳失敗不影響這次呼叫(同 api-token 的 last_used_at)。
      console.error("[mcp] last_used_at update failed", e);
    }
  }

  return {
    grantId: row.grantId,
    scope: row.scope,
    resource: row.resource,
    app: row.app,
    user: {
      id: row.userId,
      email: row.email,
      name: row.name,
      // connectPolicy 已確認是真正的管理員(預設角色、沒有自訂角色)。
      role: "admin",
      avatarKey: row.avatarKey,
      staffRole: null,
    },
  };
}

// ---- 撤銷與清單 ----

/**
 * 刪一條連線,連同它的碼與權杖。明確逐表刪(不只靠外鍵 cascade):「撤銷後權杖立刻
 * 失效」是這個功能對管理員的承諾,不該取決於資料庫有沒有開外鍵檢查。
 */
export async function revokeGrant(grantId: string): Promise<boolean> {
  const [, , removed] = await db().batch([
    db().delete(mcpTokens).where(eq(mcpTokens.grantId, grantId)),
    db().delete(mcpCodes).where(eq(mcpCodes.grantId, grantId)),
    db().delete(mcpGrants).where(eq(mcpGrants.id, grantId)).returning({ id: mcpGrants.id }),
  ]);
  return removed.length > 0;
}

/**
 * RFC 7009:App 自己要求撤銷。refresh token = 結束整條連線(App 那邊「中斷連線」就是
 * 這個意思);access token = 只刪那一把。不是這個 App 的權杖就當作沒看到 —— 規格要求
 * 一律回 200,不透露權杖存不存在。
 */
export async function revokeByToken(raw: string, clientId: string): Promise<void> {
  const rows = await db()
    .select({ kind: mcpTokens.kind, grantId: mcpTokens.grantId, clientId: mcpGrants.clientId })
    .from(mcpTokens)
    .innerJoin(mcpGrants, eq(mcpGrants.id, mcpTokens.grantId))
    .where(eq(mcpTokens.tokenHash, await hashToken(raw)))
    .limit(1);
  const row = rows[0];
  if (!row || row.clientId !== clientId) return;
  if (row.kind === "refresh") {
    await revokeGrant(row.grantId);
    return;
  }
  await db().delete(mcpTokens).where(eq(mcpTokens.tokenHash, await hashToken(raw)));
}

export interface McpConnection {
  id: string;
  app: string;
  scope: McpScope;
  approvedBy: string;
  connectedAt: number;
  lastUsedAt: number | null;
}

/** 設定頁的連線清單,新的在前。先清掉已經不會再動的連線(見 pruneStale)。 */
export async function listConnections(now: number): Promise<McpConnection[]> {
  await pruneStale(now);
  const rows = await db()
    .select({
      id: mcpGrants.id,
      app: mcpClients.name,
      scope: mcpGrants.scope,
      userName: users.name,
      userEmail: users.email,
      connectedAt: mcpGrants.createdAt,
      lastUsedAt: mcpGrants.lastUsedAt,
    })
    .from(mcpGrants)
    .innerJoin(mcpClients, eq(mcpClients.id, mcpGrants.clientId))
    .innerJoin(users, eq(users.id, mcpGrants.userId))
    .orderBy(desc(mcpGrants.createdAt));
  return rows.map((r) => ({
    id: r.id,
    app: r.app,
    scope: r.scope,
    approvedBy: r.userName.trim() || r.userEmail,
    connectedAt: r.connectedAt,
    lastUsedAt: r.lastUsedAt,
  }));
}

/**
 * 清掉過期的碼與權杖,以及「同意超過一天、手上已經沒有任何有效權杖」的連線(App 沒來換
 * 權杖,或 refresh 已過期 —— 那條連線不會再動了)。best-effort:清不掉不影響主要動作。
 */
async function pruneStale(now: number): Promise<void> {
  try {
    // batch 依序執行:前兩句先刪掉過期的,第三句的「沒有任何權杖/碼」就等於「沒有有效的」。
    await db().batch([
      db().delete(mcpCodes).where(lte(mcpCodes.expiresAt, now)),
      db().delete(mcpTokens).where(lte(mcpTokens.expiresAt, now)),
      db()
        .delete(mcpGrants)
        .where(
          and(
            lt(mcpGrants.createdAt, now - UNFINISHED_GRANT_MS),
            notExists(db().select({ h: mcpTokens.tokenHash }).from(mcpTokens).where(eq(mcpTokens.grantId, mcpGrants.id))),
            notExists(db().select({ h: mcpCodes.codeHash }).from(mcpCodes).where(eq(mcpCodes.grantId, mcpGrants.id))),
          ),
        ),
    ]);
  } catch (e) {
    console.error("[mcp] pruning stale connections failed", e);
  }
}
