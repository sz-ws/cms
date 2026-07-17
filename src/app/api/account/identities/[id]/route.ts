import { eq, and } from "drizzle-orm";
import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { db } from "@/lib/db";
import { userIdentities, users, passkeys } from "@/lib/schema";
import { SENTINEL_PASSWORD_HASH } from "@/lib/oidc";

// spec-login-providers.md §6:DELETE /api/account/identities/[id]
// — requireAuth("guest") + assertSameOrigin;只能刪自己的(否則 404)。
// **最後登入方式 guard**:若 passwordHash 是 sentinel(OAuth-only)且無 passkey 且
// 這是最後一個 identity → 400 last_login_method(避免把自己鎖死在門外)。
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    const r = originErrorResponse(e);
    if (r) return r;
    throw e;
  }

  let user;
  try {
    user = await requireAuth("guest");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  const { id } = await ctx.params;

  // 只能刪自己的:以 (id, userId) 雙條件查,查不到 → 404(不洩漏他人 identity 存在性)。
  const owned = await db()
    .select({ id: userIdentities.id })
    .from(userIdentities)
    .where(and(eq(userIdentities.id, id), eq(userIdentities.userId, user.id)))
    .limit(1);
  if (owned.length === 0) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  // 最後登入方式 guard:密碼是 sentinel + 無 passkey + 這是最後一個 identity → 拒絕。
  const [row] = await db()
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  const isOAuthOnly = row?.passwordHash === SENTINEL_PASSWORD_HASH;

  if (isOAuthOnly) {
    const pks = await db()
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.userId, user.id))
      .limit(1);
    if (pks.length === 0) {
      const allIdentities = await db()
        .select({ id: userIdentities.id })
        .from(userIdentities)
        .where(eq(userIdentities.userId, user.id));
      if (allIdentities.length <= 1) {
        return Response.json({ error: "last_login_method" }, { status: 400 });
      }
    }
  }

  await db().delete(userIdentities).where(eq(userIdentities.id, id));
  return Response.json({ ok: true });
}
