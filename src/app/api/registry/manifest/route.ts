import { requireAuth, authErrorResponse } from "@/lib/auth";
import { hitRateLimit } from "@/lib/rate-limit";
import {
  assertKnownRegistrySource,
  fetchManifest,
  registryErrorResponse,
  sourceAllowsScripts,
  UnknownRegistrySource,
} from "@/lib/registry-client";
import { parseManifest, type DeclarativeManifest } from "@/ext/dx/manifest";
import { hashScripts, parseScriptsApproval } from "@/ext/dx/scripts";
import { scriptsCompiledIn } from "@/ext/dx/scripts-compiled";
// 1.51.0:編進網站的強化層在 loader 的 import 鏈上登記(extensions/registry.ts);這支
// route 其他地方用不到 loader,少了這行,剛啟動的 isolate 會以為什麼都沒編進來。
import "@/ext/loader";
import { db } from "@/lib/db";
import { declarativeExtensions as dxTable } from "@/lib/schema";
import { eq } from "drizzle-orm";

// GET /api/registry/manifest?source=...&id=...。admin only。
// 供 install 表單「安裝前預覽」用:抓 manifest 並驗證,回傳 installPrompts(若有)
// 給前端渲染表單、scripts 的核准資訊(1.48.0)給核准畫面,不做任何寫入 —— 與 POST /api/registry/install 共用 fetch +
// parse 邏輯,但完全唯讀。錯誤形狀比照 install route(unknown_source /
// invalid_manifest / manifest_fetch_failed)方便前端共用 error 文案。
// 付費插件:registry 回 402 → 402 not_entitled(+ 消毒過的 message);401 / 403 →
// 502 source_key_invalid。其他失敗照舊 502 manifest_fetch_failed。
export async function GET(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  // admin-only 唯讀 preview,但仍會對外 fetch 一次 manifest —— 比照 install
  // route 的量級掛個溫和上限(60/min per user)。
  if (
    await hitRateLimit(user.id, {
      namespace: "registry-manifest",
      limit: 60,
      windowMs: 60_000,
    })
  ) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const url = new URL(req.url);
  const source = url.searchParams.get("source");
  const id = url.searchParams.get("id");
  if (!source || !id) {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  try {
    await assertKnownRegistrySource(source);
  } catch (e) {
    if (e instanceof UnknownRegistrySource) {
      return Response.json({ error: "unknown_source" }, { status: 400 });
    }
    throw e;
  }

  let rawManifest: unknown;
  try {
    rawManifest = await fetchManifest(source, id);
  } catch (e) {
    const known = registryErrorResponse(e);
    if (known) return known;
    return Response.json(
      {
        error: "manifest_fetch_failed",
        message: e instanceof Error ? e.message : "unknown error",
      },
      { status: 502 },
    );
  }

  const result = parseManifest(rawManifest);
  if (!result.ok || !result.manifest) {
    return Response.json(
      { error: "invalid_manifest", message: result.error },
      { status: 400 },
    );
  }

  return Response.json({
    manifest: result.manifest,
    scripts: await scriptsReview(result.manifest, source, id),
  });
}

/**
 * 1.48.0:manifest 帶 scripts 時,安裝前端要知道的三件事 —— 內容 hash(核准時原樣
 * 送回)、這個來源准不准帶 scripts、已安裝的版本是不是核准過同樣的內容(更新但
 * scripts 沒變就不必再看一次)。沒有 scripts → null。
 * 1.51.0:這個站把插件的前台編進了網站 → 也是 null:沒有要核准的東西(install route
 * 同樣不看來源、不要核准)。
 */
async function scriptsReview(
  manifest: DeclarativeManifest,
  source: string,
  id: string,
): Promise<{ hash: string; allowed: boolean; approved: boolean } | null> {
  if (!manifest.scripts || scriptsCompiledIn(id)) return null;
  const [hash, allowed, rows] = await Promise.all([
    hashScripts(manifest.scripts),
    sourceAllowsScripts(source),
    db()
      .select({ scriptsApproval: dxTable.scriptsApproval })
      .from(dxTable)
      .where(eq(dxTable.id, id))
      .limit(1),
  ]);
  const approved = parseScriptsApproval(rows[0]?.scriptsApproval)?.hash === hash;
  return { hash, allowed, approved };
}
