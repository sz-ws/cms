import { z } from "zod";
import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { getSetting, setSettings } from "@/lib/settings";
import { adminThemeSchema, resolveAdminAppearance } from "@/lib/admin-theme";

const appearanceSchema = z.strictObject({ theme: adminThemeSchema, accent: z.string().regex(/^#[0-9a-f]{6}$/) });

export async function GET(): Promise<Response> {
  try { await requireAuth("guest"); } catch (e) {
    const response = authErrorResponse(e);
    if (response) return response;
    throw e;
  }
  const appearance = resolveAdminAppearance(await getSetting("core.adminTheme", null), await getSetting("core.adminAccent", null));
  return Response.json(appearance, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PUT(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    await requireAuth("admin");
  } catch (e) {
    const response = originErrorResponse(e) ?? authErrorResponse(e);
    if (response) return response;
    throw e;
  }
  let body: unknown;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid_input" }, { status: 400 }); }
  const parsed = appearanceSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "invalid_theme", fields: parsed.error.issues.map((issue) => issue.path.join(".")) }, { status: 400 });
  // One D1 batch: a preset's palette and legacy accent change together.
  await setSettings({ "core.adminTheme": parsed.data.theme, "core.adminAccent": parsed.data.accent });
  return Response.json(parsed.data, { headers: { "Cache-Control": "private, no-store" } });
}
