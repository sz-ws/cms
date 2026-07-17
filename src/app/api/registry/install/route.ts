import { z } from "zod";
import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { hitRateLimit } from "@/lib/rate-limit";
import {
  assertKnownRegistrySource,
  fetchManifest,
  fetchExtensionAsset,
  UnknownRegistrySource,
} from "@/lib/registry-client";
import { parseManifest } from "@/ext/dx/manifest";
import { validateStylesheet } from "@/ext/dx/stylesheet-guard";
import { missingCapabilities } from "@/ext/features";
import {
  availableServices,
  unmetRequiredServices,
} from "@/ext/service-requirements";
import { validatePromptValues } from "@/ext/dx/install-prompts";
import { runDeclarativeMigrations } from "@/ext/dx/declarative-migrate";
import { satisfies } from "@/ext/semver";
import { CORE_API_VERSION } from "@/ext/version";
import { db } from "@/lib/db";
import {
  declarativeExtensions as dxTable,
  extensions as extTable,
  settings,
} from "@/lib/schema";
import { eq } from "drizzle-orm";
import { getExtRuntime, invalidateExtRuntimeMemo } from "@/ext/loader";
import { revalidateExt } from "@/ext/dx/cache-invalidate";
import {
  setExtensionSettingsRaw,
  invalidateSettingsCache,
} from "@/lib/settings";

// core-v2 §3.4:POST /api/registry/install。admin + Origin 檢查。
// body { id, source, promptValues? }。install 與 update 共用(upsert semantics)。
// promptValues:對應 manifest.installPrompts 的使用者填值(見 validatePromptValues);
// 未宣告 installPrompts 的 manifest 忽略此欄位(空物件驗證一律通過)。
const bodySchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    promptValues: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
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

  // Phase E §4: rate limit installs by user (30/min) — this fetches an
  // external manifest per call, worth bounding even for an admin-only route.
  if (
    await hitRateLimit(user.id, {
      namespace: "registry-install",
      limit: 30,
      windowMs: 60_000,
    })
  ) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  const { id, source, promptValues } = parsed;

  // SSRF guard(§5):source 必須完全等於已設定的 core.registrySources 其中一個,
  // 絕不接受 request body 內任意 URL。
  try {
    await assertKnownRegistrySource(source);
  } catch (e) {
    if (e instanceof UnknownRegistrySource) {
      return Response.json({ error: "unknown_source" }, { status: 400 });
    }
    throw e;
  }

  // id collision with an existing code extension → refuse(declarative 永不覆寫 code)。
  const codeRow = await db()
    .select({ id: extTable.id })
    .from(extTable)
    .where(eq(extTable.id, id))
    .limit(1);
  if (codeRow.length > 0) {
    return Response.json(
      { error: "id_collision_with_code_extension" },
      { status: 409 },
    );
  }

  let rawManifest: unknown;
  try {
    rawManifest = await fetchManifest(source, id);
  } catch (e) {
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
  const manifest = result.manifest;

  // manifest.id must match the requested id (defense: registry entry and manifest agree).
  if (manifest.id !== id) {
    return Response.json(
      {
        error: "invalid_manifest",
        message: `manifest id "${manifest.id}" does not match requested id "${id}"`,
      },
      { status: 400 },
    );
  }

  if (!satisfies(CORE_API_VERSION, manifest.coreApi)) {
    return Response.json(
      {
        error: "incompatible_core_api",
        message: `extension "${id}" requires coreApi "${manifest.coreApi}" but core is ${CORE_API_VERSION}`,
      },
      { status: 409 },
    );
  }

  // roadmap #17:manifest.capabilities 逐一比對 CORE_FEATURES —— 有任何一個這個
  // core 不支援(通常代表 manifest 是給更新版本的 core 寫的)就擋下 install,而不是
  // 讓它裝上去後才在 runtime 悄悄壞掉。
  const missing = missingCapabilities(manifest.capabilities);
  if (missing.length > 0) {
    return Response.json(
      {
        error: "missing_capabilities",
        missing,
        message: `extension "${id}" requires platform features not supported by this core: ${missing.join(", ")}`,
      },
      { status: 409 },
    );
  }

  // manifest.requires(服務需求):非 optional 的 capability 目前無 provider →
  // 擋下(同上哲學:先裝提供該服務的 extension,而不是裝上去 runtime 才爆)。
  // optional 缺席不擋,Browse UI 顯示建議。
  const unmetServices = unmetRequiredServices(
    manifest.requires,
    await availableServices(),
  );
  if (unmetServices.length > 0) {
    return Response.json(
      {
        error: "missing_services",
        missing: unmetServices,
        message: `extension "${id}" requires services with no installed provider: ${unmetServices.join(", ")}`,
      },
      { status: 409 },
    );
  }

  // installPrompts(可選):使用者於安裝表單填的值,對照 manifest.installPrompts
  // 驗證型別 + required。驗證失敗一律 400,不觸碰 migrations / DB(fail fast)。
  const promptValidation = validatePromptValues(manifest.installPrompts, promptValues);
  if (!promptValidation.ok) {
    return Response.json(
      { error: promptValidation.error, fields: promptValidation.fields },
      { status: 400 },
    );
  }
  const promptedValues = promptValidation.values;

  // 1.8.0 stylesheet(可選):manifest 宣告 stylesheet:"style.css" → 抓取並驗證。
  // fetch 或 validate 任一失敗 → 400 invalid_stylesheet,且在「任何 DB 寫入之前」
  // (含 migrations)fail fast —— extension 不安裝/不更新。manifest 未宣告 → NULL
  // (update 時清掉先前存的 sheet)。validateStylesheet 是 REJECT-not-rewrite:見
  // stylesheet-guard.ts;第三方 CSS 於本站同源執行,故所有逃逸向量都擋在安裝時。
  let validatedStylesheet: string | null = null;
  if (manifest.stylesheet) {
    let rawCss: string;
    try {
      rawCss = await fetchExtensionAsset(source, id, manifest.stylesheet);
    } catch (e) {
      return Response.json(
        {
          error: "invalid_stylesheet",
          message: `failed to fetch style.css: ${e instanceof Error ? e.message : "unknown error"}`,
        },
        { status: 400 },
      );
    }
    const verdict = validateStylesheet(rawCss);
    if (!verdict.ok) {
      return Response.json(
        { error: "invalid_stylesheet", message: verdict.reason },
        { status: 400 },
      );
    }
    validatedStylesheet = rawCss;
  }

  // manifest.migrations(可選 DDL,zod 已把關 CREATE … IF NOT EXISTS 白名單):
  // 在寫入 declarative_extensions 之前套用 —— 表建失敗就不該讓 extension 上線。
  // helper 冪等(ext_migrations 記錄 + IF NOT EXISTS 雙保險),update 重跑 noop。
  try {
    await runDeclarativeMigrations(id, manifest.migrations ?? []);
  } catch (e) {
    return Response.json(
      {
        error: "migration_failed",
        message: e instanceof Error ? e.message : "unknown error",
      },
      { status: 500 },
    );
  }

  const now = Date.now();

  // upsert declarative_extensions:enabled=1, source, version, timestamps。
  // 硬規則(同 manager.ts enableExtension):ON CONFLICT SET 不得包含 installed_at。
  await db()
    .insert(dxTable)
    .values({
      id,
      manifest: JSON.stringify(manifest),
      version: manifest.version,
      enabled: 1,
      source,
      // 已驗證的 CSS(或 null 清除先前 sheet);見上方 stylesheet fetch/validate。
      stylesheet: validatedStylesheet,
      installedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: dxTable.id,
      set: {
        manifest: JSON.stringify(manifest),
        version: manifest.version,
        enabled: 1,
        source,
        stylesheet: validatedStylesheet,
        updatedAt: now,
      },
    });

  // 寫入預設 settings(同 manager.ts enableExtension 步驟 3):
  // 對 manifest.settings 每項,若 settings 表無 ext.<id>.<key> → insert default。
  // 若使用者透過 installPrompts 提供了該 key 的值,default insert 跳過(改由下方
  // setExtensionSettingsRaw 用 upsert 寫入使用者提供的值,覆蓋既有值)。
  const promptedKeys = new Set(Object.keys(promptedValues));
  for (const field of manifest.settings ?? []) {
    if (promptedKeys.has(field.key)) continue;
    const key = `ext.${id}.${field.key}`;
    await db()
      .insert(settings)
      .values({ key, value: JSON.stringify(field.default), updatedAt: now })
      .onConflictDoNothing({ target: settings.key });
  }

  // installPrompts 提供的值:寫入 ext.<id>.<key>(upsert,覆蓋既有值)。這裡尚未
  // fire ext:enabled,extension 還不在 enabled runtime 內,setSettings 的自動加密
  // 判定會漏判 secret key —— 改用 setExtensionSettingsRaw,secretKeys 直接從
  // manifest.settings[].secret 算(此 request 手上已有完整 manifest,不必等 runtime)。
  if (promptedKeys.size > 0) {
    const secretKeys = new Set(
      (manifest.settings ?? [])
        .filter((f) => f.secret)
        .map((f) => `ext.${id}.${f.key}`),
    );
    const entries: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(promptedValues)) {
      entries[`ext.${id}.${key}`] = value;
    }
    await setExtensionSettingsRaw(entries, secretKeys);
  }

  // memo 主動失效(belt-and-braces;跨 isolate 靠 stamp)。
  invalidateExtRuntimeMemo();
  // 上面寫了預設 / prompted settings,失效 isolate settings 快取(同 isolate 立即生效)。
  invalidateSettingsCache();
  // 該 extension 的 public content cache 整批失效(install/update 後結構/資料可能全變)。
  revalidateExt(id);

  // fire ext:enabled(既有 install/update 皆視為「啟用」;下一個 request 的 runtime 才看得到)。
  const rt = await getExtRuntime();
  await rt.hooks.doAction("ext:enabled", id);

  return Response.json({ ok: true, id, version: manifest.version });
}
