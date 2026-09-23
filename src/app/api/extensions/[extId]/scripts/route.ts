import { z } from "zod";
import { eq } from "drizzle-orm";
import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { db } from "@/lib/db";
import { declarativeExtensions as dxTable } from "@/lib/schema";
import { sourceAllowsScripts } from "@/lib/registry-client";
import { parseManifest, type DeclarativeManifest } from "@/ext/dx/manifest";
import {
  hashScripts,
  parseScriptsApproval,
  SCRIPTS_HASH_RE,
} from "@/ext/dx/scripts";
import { scriptsCompiledIn } from "@/ext/dx/scripts-compiled";
import { buildInstallRevisionClaim } from "@/ext/dx/declarative-migrate";
import { isStaleInstallConflict } from "@/ext/dx/install-contract";
import { invalidateExtRuntimeMemo } from "@/ext/loader";

// 1.48.0:已安裝的宣告式插件的 scripts —— 查看、停用、重新核准。
//
// GET  → 核准畫面要的資料(內容、hash、來源准不准、目前是否核准)
// POST { action: "stop" }            → 清掉核准紀錄,前台立刻不再載入
// POST { action: "approve", hash }   → hash 必須等於目前內容的 hash
//
// 安裝時的核准走 POST /api/registry/install 的 approveScripts;這裡處理的是之後:
// 管理員想先停掉某段 script、或停掉之後要再打開。admin only。
//
// 1.51.0:插件的前台已經編進網站(public:scripts)→ approve 回 409 scripts_compiled。
// 那些 script 不會輸出,核准只會讓它們的主機進 CSP 白名單(見 @/ext/dx/scripts-compiled)。

type Loaded =
  | { ok: true; row: typeof dxTable.$inferSelect; manifest: DeclarativeManifest }
  | { ok: false; response: Response };

async function loadWithScripts(extId: string): Promise<Loaded> {
  const rows = await db().select().from(dxTable).where(eq(dxTable.id, extId)).limit(1);
  const row = rows[0];
  if (!row) return { ok: false, response: Response.json({ error: "not_found" }, { status: 404 }) };
  let json: unknown;
  try {
    json = JSON.parse(row.manifest);
  } catch {
    json = null;
  }
  const parsed = parseManifest(json);
  if (!parsed.ok || !parsed.manifest) {
    return { ok: false, response: Response.json({ error: "installed_manifest_invalid" }, { status: 409 }) };
  }
  if (!parsed.manifest.scripts) {
    return { ok: false, response: Response.json({ error: "no_scripts" }, { status: 404 }) };
  }
  return { ok: true, row, manifest: parsed.manifest };
}

/** 沒有來源的列只可能來自開發模式的 inline 安裝(正式 bundle 沒有那條路)。 */
async function allowedFor(source: string | null): Promise<boolean> {
  if (source === null) return process.env.NODE_ENV !== "production";
  return sourceAllowsScripts(source);
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ extId: string }> },
): Promise<Response> {
  try {
    await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  const { extId } = await ctx.params;
  const loaded = await loadWithScripts(extId);
  if (!loaded.ok) return loaded.response;
  const { row, manifest } = loaded;
  const scripts = manifest.scripts ?? [];

  const hash = await hashScripts(scripts);
  const approval = parseScriptsApproval(row.scriptsApproval);

  return Response.json({
    scripts,
    hash,
    allowed: await allowedFor(row.source),
    approval: approval && approval.hash === hash ? { by: approval.by, at: approval.at } : null,
  });
}

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("stop") }).strict(),
  z.object({ action: z.literal("approve"), hash: z.string().regex(SCRIPTS_HASH_RE) }).strict(),
]);

export async function POST(
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

  let user;
  try {
    user = await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  const { extId } = await ctx.params;
  const loaded = await loadWithScripts(extId);
  if (!loaded.ok) return loaded.response;
  const { row, manifest } = loaded;

  let scriptsApproval: string | null = null;
  if (body.action === "approve") {
    if (scriptsCompiledIn(extId)) {
      return Response.json({ error: "scripts_compiled" }, { status: 409 });
    }
    if (!(await allowedFor(row.source))) {
      return Response.json({ error: "scripts_not_allowed" }, { status: 403 });
    }
    const hash = await hashScripts(manifest.scripts ?? []);
    if (body.hash !== hash) {
      return Response.json({ error: "scripts_changed", hash }, { status: 409 });
    }
    scriptsApproval = JSON.stringify({ hash, by: user.email, at: Date.now() });
  }

  // 同 enable/disable:推進 revision(載入器的快取戳記跟著換),並跟同時進行的安裝互斥。
  const now = Math.max(Date.now(), row.updatedAt + 1);
  try {
    await db().batch([
      buildInstallRevisionClaim(extId, row.updatedAt, now),
      db()
        .update(dxTable)
        .set({ scriptsApproval, updatedAt: now })
        .where(eq(dxTable.id, extId)),
    ]);
  } catch (e) {
    if (isStaleInstallConflict(e)) {
      return Response.json({ error: "stale_install_conflict" }, { status: 409 });
    }
    throw e;
  }
  invalidateExtRuntimeMemo();

  return Response.json({ ok: true, approved: scriptsApproval !== null });
}
