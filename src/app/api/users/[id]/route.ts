import { eq } from "drizzle-orm";
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
import { staffRoleExists } from "@/lib/staff-roles";

// 1.50.0:staffRoleId 指派自訂角色(users.role 同時寫成 guest,見 migrations/0021);
// role 指派預設角色(同時清掉自訂角色)。兩個不能同時給。
const patchSchema = z
  .object({
    name: z.string().min(1).optional(),
    role: z.enum(["admin", "editor", "guest"]).optional(),
    staffRoleId: z.string().min(1).max(64).optional(),
    password: z.string().min(8).optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: "empty_patch" })
  .refine((o) => o.role === undefined || o.staffRoleId === undefined, {
    message: "role_or_staff_role",
  });

// PATCH /api/users/[id]:更新 name / role / password(email 是身分,不可改)。
// 自己的 role 不可改(cannot_change_own_role)—— 防止把自己降權後鎖死管理面;
// name/password 改自己是合法的。密碼走同一條 hashPassword 管線。
// 不發 hook:HookName 是封閉聯集,新增 "user:updated" 屬 CORE_API minor bump,另案。
export async function PATCH(
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

  let self;
  try {
    self = await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  let parsed: z.infer<typeof patchSchema>;
  try {
    parsed = patchSchema.parse(await req.json());
  } catch {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  const { id } = await ctx.params;
  const changesRole =
    (parsed.role !== undefined && parsed.role !== self.role) ||
    parsed.staffRoleId !== undefined;
  if (id === self.id && changesRole) {
    return Response.json({ error: "cannot_change_own_role" }, { status: 400 });
  }
  if (parsed.staffRoleId !== undefined && !(await staffRoleExists(parsed.staffRoleId))) {
    return Response.json({ error: "role_not_found" }, { status: 400 });
  }

  const existing = await db()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (existing.length === 0) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const patch: Partial<{
    name: string;
    role: "admin" | "editor" | "guest";
    staffRoleId: string | null;
    passwordHash: string;
  }> = {};
  if (parsed.name !== undefined) patch.name = parsed.name;
  if (parsed.role !== undefined) {
    patch.role = parsed.role;
    patch.staffRoleId = null;
  }
  if (parsed.staffRoleId !== undefined) {
    patch.role = "guest";
    patch.staffRoleId = parsed.staffRoleId;
  }
  if (parsed.password !== undefined)
    patch.passwordHash = await hashPassword(parsed.password);

  await db().update(users).set(patch).where(eq(users.id, id));

  const [row] = await db()
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      avatarKey: users.avatarKey,
      staffRoleId: users.staffRoleId,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  const user: SessionUser & { staffRoleId: string | null } = row;
  return Response.json({ user });
}

// DELETE /api/users/[id]:id = 自己 → 400;否則刪除(sessions 由 FK cascade 清掉)。
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

  let self;
  try {
    self = await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  const { id } = await ctx.params;
  if (id === self.id) {
    return Response.json({ error: "cannot_delete_self" }, { status: 400 });
  }

  await db().delete(users).where(eq(users.id, id));
  return Response.json({ ok: true });
}
