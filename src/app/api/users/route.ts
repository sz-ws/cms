import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import {
  requireAuth,
  authErrorResponse,
  hashPassword,
  type SessionUser,
} from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { getExtRuntime } from "@/ext/loader";

export const dynamic = "force-dynamic";

// GET /api/users → { users: SessionUser[] }(不含 password_hash)。
export async function GET(): Promise<Response> {
  try {
    await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  const rows = await db()
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      avatarKey: users.avatarKey,
    })
    .from(users);
  const list: SessionUser[] = rows;
  return Response.json({ users: list });
}

const createSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["admin", "editor", "guest"]),
  password: z.string().min(8),
});

// POST /api/users → 建立(email 轉小寫、重複 409)→ doAction("user:created") → 201。
export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    const r = originErrorResponse(e);
    if (r) return r;
    throw e;
  }

  try {
    await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  let parsed: z.infer<typeof createSchema>;
  try {
    parsed = createSchema.parse(await req.json());
  } catch {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  const email = parsed.email.toLowerCase();
  const existing = await db()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing.length > 0) {
    return Response.json({ error: "email_exists" }, { status: 409 });
  }

  const id = nanoid();
  const passwordHash = await hashPassword(parsed.password);
  await db().insert(users).values({
    id,
    email,
    passwordHash,
    name: parsed.name,
    role: parsed.role,
    createdAt: Date.now(),
  });

  // doAction("user:created", user)(04 §7)。
  const user: SessionUser = {
    id,
    email,
    name: parsed.name,
    role: parsed.role,
    avatarKey: null,
  };
  const rt = await getExtRuntime();
  await rt.hooks.doAction("user:created", user);
  return Response.json({ user }, { status: 201 });
}
