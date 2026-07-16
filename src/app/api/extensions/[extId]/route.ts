import { z } from "zod";
import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import {
  enableExtension,
  disableExtension,
  uninstallExtension,
  enableDeclarative,
  disableDeclarative,
  uninstallDeclarative,
  ExtNotFound,
} from "@/ext/manager";

export const dynamic = "force-dynamic";

// 05 §2:PATCH /api/extensions/[extId]。admin only + Origin 檢查。
// body { action: "enable" | "disable" | "uninstall", kind?: "code" | "declarative", purgeContent?: boolean }。
// declarative uninstall(core-v2 §3.4 Phase D):purgeContent 決定是否連帶刪除該 extension
// 的 contents 列(type LIKE "<extId>.%")。
const bodySchema = z.object({
  action: z.enum(["enable", "disable", "uninstall"]),
  kind: z.enum(["code", "declarative"]).optional(),
  purgeContent: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ extId: string }> },
): Promise<Response> {
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

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  const { extId } = await ctx.params;

  try {
    if (parsed.kind === "declarative") {
      if (parsed.action === "enable") await enableDeclarative(extId);
      else if (parsed.action === "disable") await disableDeclarative(extId);
      else await uninstallDeclarative(extId, parsed.purgeContent === true);
    } else if (parsed.action === "enable") await enableExtension(extId);
    else if (parsed.action === "disable") await disableExtension(extId);
    else await uninstallExtension(extId);
  } catch (e) {
    if (e instanceof ExtNotFound) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    // 部分啟用 / migration 失敗:回 500,前端顯示「啟用未完成,請重試」(03 §5,重入冪等)。
    console.error(`[extensions:${parsed.action}] ext=${extId}`, e);
    return Response.json({ error: "action_failed" }, { status: 500 });
  }

  return Response.json({ ok: true });
}
