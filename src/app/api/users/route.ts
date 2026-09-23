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
import { staffRoleExists } from "@/lib/staff-roles";

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
      // 1.50.0:自訂角色(有值時 role 是 guest,實際權限看角色)。
      staffRoleId: users.staffRoleId,
    })
    .from(users);
  const list: (SessionUser & { staffRoleId: string | null })[] = rows;
  return Response.json({ users: list });
}

// 1.50.0:staffRoleId 給了就是自訂角色(role 寫成 guest,見 migrations/0021)。
const createSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["admin", "editor", "guest"]),
  staffRoleId: z.string().min(1).max(64).optional(),
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

  if (parsed.staffRoleId !== undefined && !(await staffRoleExists(parsed.staffRoleId))) {
    return Response.json({ error: "role_not_found" }, { status: 400 });
  }
  const role = parsed.staffRoleId !== undefined ? "guest" : parsed.role;

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
    role,
    staffRoleId: parsed.staffRoleId ?? null,
    createdAt: Date.now(),
  });

  // doAction("user:created", user)(04 §7)。
  const user: SessionUser = {
    id,
    email,
    name: parsed.name,
    role,
    avatarKey: null,
  };
  const rt = await getExtRuntime();
  await rt.hooks.doAction("user:created", user);
  return Response.json({ user }, { status: 201 });
}
