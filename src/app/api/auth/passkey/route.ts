import { eq } from "drizzle-orm";
import { requireAuth, authErrorResponse } from "@/lib/auth";
import { db } from "@/lib/db";
import { passkeys } from "@/lib/schema";

// L1 §3:requireAuth() → 列出自己的 passkeys(id、name、createdAt、lastUsedAt;不含 public_key)。
export async function GET(): Promise<Response> {
  try {
    const user = await requireAuth();
    const rows = await db()
      .select({
        id: passkeys.id,
        name: passkeys.name,
        createdAt: passkeys.createdAt,
        lastUsedAt: passkeys.lastUsedAt,
      })
      .from(passkeys)
      .where(eq(passkeys.userId, user.id));
    return Response.json({ passkeys: rows });
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }
}
