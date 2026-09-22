import { ExtensionLifecycleConflict } from "@/ext/code-lifecycle";
import { eq } from "drizzle-orm";
import { isBaseManaged, isBuiltinDeclarative } from "@/ext/builtin-declaratives";
import { db } from "@/lib/db";
import { declarativeExtensions as dxTable } from "@/lib/schema";
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
  CoreApiIncompatible,
  enableStepCheck,
  enableStepMigrate,
  enableStepSettings,
  enableStepRecord,
} from "@/ext/manager";

// 05 §2:PATCH /api/extensions/[extId]。admin only + Origin 檢查。
// body { action: "enable" | "disable" | "uninstall", kind?: "code" | "declarative", purgeContent?: boolean }。
// declarative uninstall(core-v2 §3.4 Phase D):purgeContent 決定是否連帶刪除該 extension
// 的 contents 列(type LIKE "<extId>.%")。
// 1.45.0:action "enable-step" 一次只做啟用的一步(manager.ts 的 enableStep*),後台依序呼叫
// check → 每個 migration → settings → record,邊做邊顯示進度。
const bodySchema = z.object({
  action: z.enum(["enable", "disable", "uninstall", "enable-step"]),
  kind: z.enum(["code", "declarative"]).optional(),
  purgeContent: z.boolean().optional(),
  step: z.enum(["check", "migrate", "settings", "record"]).optional(),
  migration: z.string().min(1).max(100).optional(),
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
    if (parsed.action === "enable-step") {
      if (parsed.step === "check") return Response.json({ ok: true, ...(await enableStepCheck(extId)) });
      if (parsed.step === "migrate" && parsed.migration) {
        return Response.json({ ok: true, result: await enableStepMigrate(extId, parsed.migration) });
      }
      if (parsed.step === "settings") return Response.json({ ok: true, count: await enableStepSettings(extId) });
      if (parsed.step === "record") {
        await enableStepRecord(extId);
        return Response.json({ ok: true });
      }
      return Response.json({ error: "invalid_input" }, { status: 400 });
    }
    if (parsed.kind === "declarative") {
      // 1.49.0:底座管的(商品目錄)由商店設定開關,不能在這裡啟停或移除。從 registry
      // 裝、底座還沒接手的舊列(站上沒有商店)照舊由管理員自己管。
      if (isBuiltinDeclarative(extId)) {
        const [row] = await db()
          .select({ source: dxTable.source })
          .from(dxTable)
          .where(eq(dxTable.id, extId))
          .limit(1);
        if (row && isBaseManaged(extId, row.source)) {
          return Response.json({ error: "builtin_extension" }, { status: 409 });
        }
      }
      if (parsed.action === "enable") await enableDeclarative(extId);
      else if (parsed.action === "disable") await disableDeclarative(extId);
      else await uninstallDeclarative(extId, parsed.purgeContent === true);
    } else if (parsed.action === "enable") await enableExtension(extId);
    else if (parsed.action === "disable") await disableExtension(extId);
    else await uninstallExtension(extId);
  } catch (e) {
    if (e instanceof ExtensionLifecycleConflict || e instanceof CoreApiIncompatible) {
      return Response.json({ error: e.message }, { status: 409 });
    }
    if (e instanceof ExtNotFound) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    // 部分啟用 / migration 失敗:回 500,前端顯示「啟用未完成,請重試」(03 §5,重入冪等)。
    console.error(`[extensions:${parsed.action}] ext=${extId}`, e);
    return Response.json({ error: "action_failed" }, { status: 500 });
  }

  return Response.json({ ok: true });
}
