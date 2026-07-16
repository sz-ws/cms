import { requireAuth, authErrorResponse } from "@/lib/auth";
import { listLoginProviders, listUserIdentities } from "@/lib/oidc";

export const dynamic = "force-dynamic";

// spec-login-providers.md §6:GET /api/account/identities — requireAuth("guest")。
// 回自己的 identities(id, provider, display, createdAt, lastUsedAt)+ 可綁的
// provider 清單(clientId/secret 已設定者)。帳號自身端點,故放行 guest。
export async function GET(): Promise<Response> {
  let user;
  try {
    user = await requireAuth("guest");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  const [identities, providers] = await Promise.all([
    listUserIdentities(user.id),
    listLoginProviders(),
  ]);
  return Response.json({ identities, providers });
}
