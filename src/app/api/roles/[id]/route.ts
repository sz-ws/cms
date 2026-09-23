import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { readBoundedJsonObject } from "@/lib/body-limit";
import {
  StaffRoleError,
  deleteStaffRole,
  staffRolePatchSchema,
  updateStaffRole,
} from "@/lib/staff-roles";

// 1.50.0:PATCH /api/roles/<id>(改名稱或權限)、DELETE /api/roles/<id>(使用它的成員
// 改成訪客,同一個 batch)。只有管理者。改動下一個 request 就生效:每個 request 都從
// D1 讀角色,沒有快取要清。

const MAX_BODY_BYTES = 64_000;

async function guard(req: Request): Promise<Response | null> {
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
  return null;
}

function roleError(e: unknown): Response {
  if (e instanceof StaffRoleError) {
    return Response.json(
      { error: e.code },
      { status: e.code === "not_found" ? 404 : 409 },
    );
  }
  throw e;
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const body = await readBoundedJsonObject(req, MAX_BODY_BYTES, "roles");
  if (!body.ok) {
    return Response.json(
      { error: "invalid_input" },
      { status: body.reason === "too_large" ? 413 : 400 },
    );
  }
  const parsed = staffRolePatchSchema.safeParse(body.value);
  if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });

  const { id } = await ctx.params;
  try {
    await updateStaffRole(id, parsed.data);
  } catch (e) {
    return roleError(e);
  }
  return Response.json({ ok: true });
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const { id } = await ctx.params;
  try {
    const moved = await deleteStaffRole(id);
    return Response.json({ ok: true, moved });
  } catch (e) {
    return roleError(e);
  }
}
