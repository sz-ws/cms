import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { readBoundedJsonObject } from "@/lib/body-limit";
import {
  StaffRoleError,
  createStaffRole,
  staffRoleInputSchema,
} from "@/lib/staff-roles";

// 1.50.0:POST /api/roles —— 新增自訂角色 { name, access } → 201 { role }。
// 只有管理者(自訂角色在這裡沒有門,requireAuth("admin") 對它永遠 403)。
// access 在寫入前收斂(ext/admin-access.ts sanitizeAccess):只留可授權的頁。

const MAX_BODY_BYTES = 64_000;

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

  const body = await readBoundedJsonObject(req, MAX_BODY_BYTES, "roles");
  if (!body.ok) {
    return Response.json(
      { error: "invalid_input" },
      { status: body.reason === "too_large" ? 413 : 400 },
    );
  }
  const parsed = staffRoleInputSchema.safeParse(body.value);
  if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });

  try {
    const role = await createStaffRole(parsed.data);
    return Response.json({ role }, { status: 201 });
  } catch (e) {
    if (e instanceof StaffRoleError) {
      return Response.json({ error: e.code }, { status: 409 });
    }
    throw e;
  }
}
