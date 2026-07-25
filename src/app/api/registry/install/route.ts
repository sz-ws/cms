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
import {
  isStaleInstallConflict,
  migrationHistoryChanged,
} from "@/ext/dx/install-contract";
import { missingCapabilities } from "@/ext/features";
import {
  availableServices,
  unmetRequiredServices,
} from "@/ext/service-requirements";
import { validatePromptValues } from "@/ext/dx/install-prompts";
import {
  buildDeclarativeMigrationBatch,
  buildInstallRevisionClaim,
} from "@/ext/dx/declarative-migrate";
import { satisfies } from "@/ext/semver";
import { CORE_API_VERSION } from "@/ext/version";
import {
  incompatibleSettingContract,
  validateSettingValue,
} from "@/lib/setting-validation";
import { db } from "@/lib/db";
import {
  declarativeExtensions as dxTable,
  extMigrations,
  extensions as extTable,
  settings,
} from "@/lib/schema";
import { desc, eq, like } from "drizzle-orm";
import { getExtRuntime, invalidateExtRuntimeMemo } from "@/ext/loader";
import { revalidateExt } from "@/ext/dx/cache-invalidate";
import {
  prepareExtensionSettingValues,
  invalidateSettingsCache,
} from "@/lib/settings";
import type { BatchItem } from "drizzle-orm/batch";

// core-v2 §3.4:POST /api/registry/install。admin + Origin 檢查。
// body { id, source, promptValues? }。install 與 update 共用(upsert semantics)。
// promptValues:對應 manifest.installPrompts 的使用者填值(見 validatePromptValues);
// 未宣告 installPrompts 的 manifest 忽略此欄位(空物件驗證一律通過)。
//
// 開發模式另接受 { id, manifest } —— 直接給 manifest 物件,不經 registry。
// 動機:正式路徑要求 manifest 出現在某個已註冊 source 的 https raw URL 上,
// 於是「寫自己的 manifest」變成每改一次就要 push 一次,沒有本機迭代迴圈。
// 而 manifest 正是這套系統的產品本體,那條迴圈斷掉的代價很高。
//
// 安全性:這條分支由 `process.env.NODE_ENV !== "production"` 守住,而該判斷
// 在 next build 會被靜態求值並做 dead-code elimination —— **這段程式碼不會存在
// 於正式 bundle 裡**,不是執行期檢查。這是刻意的:新增一條繞過 SSRF 護欄的
// 安裝路徑,唯一可接受的閘門就是「它在正式環境根本不存在」。
const DEV_INSTALL = process.env.NODE_ENV !== "production";

const bodySchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1).optional(),
    // 未型別化:一律交給下游的 parseManifest 做完整 zod 驗證,與 registry
    // 路徑走同一套驗證,不因為來源不同而放寬。
    manifest: z.unknown().optional(),
    promptValues: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine(
    (b) => (b.source === undefined) !== (b.manifest === undefined),
    { message: "provide exactly one of `source` or `manifest`" },
  );

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
  const inlineManifest = parsed.manifest;

  if (inlineManifest !== undefined && !DEV_INSTALL) {
    // 正式 bundle 走不到這裡(整段會被 DCE 掉),留著是為了「萬一」——
    // 語意上等同於「這個欄位不存在」。
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  // SSRF guard(§5):source 必須完全等於已設定的 core.registrySources 其中一個,
  // 絕不接受 request body 內任意 URL。inline manifest 沒有遠端來源可抓,略過。
  if (source !== undefined) {
    try {
      await assertKnownRegistrySource(source);
    } catch (e) {
      if (e instanceof UnknownRegistrySource) {
        return Response.json({ error: "unknown_source" }, { status: 400 });
      }
      throw e;
    }
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
  if (inlineManifest !== undefined) {
    rawManifest = inlineManifest;
  } else {
  try {
    rawManifest = await fetchManifest(source as string, id);
  } catch (e) {
    return Response.json(
      {
        error: "manifest_fetch_failed",
        message: e instanceof Error ? e.message : "unknown error",
      },
      { status: 502 },
    );
  }
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

  const existingRows = await db()
    .select({
      manifest: dxTable.manifest,
      version: dxTable.version,
      updatedAt: dxTable.updatedAt,
    })
    .from(dxTable)
    .where(eq(dxTable.id, id))
    .limit(1);
  let previousManifest: typeof manifest | undefined;
  if (existingRows[0]) {
    let previousJson: unknown;
    try {
      previousJson = JSON.parse(existingRows[0].manifest);
    } catch {
      return Response.json(
        { error: "installed_manifest_invalid" },
        { status: 409 },
      );
    }
    const previousResult = parseManifest(previousJson);
    if (!previousResult.ok || !previousResult.manifest) {
      return Response.json(
        { error: "installed_manifest_invalid" },
        { status: 409 },
      );
    }
    previousManifest = previousResult.manifest;
    const incompatible = incompatibleSettingContract(
      previousManifest.settings ?? [],
      manifest.settings ?? [],
    );
    if (incompatible.length > 0) {
      return Response.json(
        {
          error: "incompatible_setting_contract",
          fields: incompatible,
          fromVersion: existingRows[0].version,
          toVersion: manifest.version,
        },
        { status: 409 },
      );
    }
    const previousMigrations = previousManifest.migrations ?? [];
    const nextMigrations = manifest.migrations ?? [];
    if (migrationHistoryChanged(previousMigrations, nextMigrations)) {
      return Response.json(
        {
          error: "migration_history_changed",
          fromVersion: existingRows[0].version,
          toVersion: manifest.version,
        },
        { status: 409 },
      );
    }
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
  const settingsByKey = new Map(
    (manifest.settings ?? []).map((field) => [field.key, field]),
  );
  const invalidPromptFields: string[] = [];
  for (const [key, value] of Object.entries(promptedValues)) {
    const field = settingsByKey.get(key);
    if (field && validateSettingValue(field, value)) {
      invalidPromptFields.push(key);
    }
  }
  if (invalidPromptFields.length > 0) {
    return Response.json(
      { error: "invalid_prompt_values", fields: invalidPromptFields },
      { status: 400 },
    );
  }

  // 1.8.0 stylesheet(可選):manifest 宣告 stylesheet:"style.css" → 抓取並驗證。
  // fetch 或 validate 任一失敗 → 400 invalid_stylesheet,且在「任何 DB 寫入之前」
  // (含 migrations)fail fast —— extension 不安裝/不更新。manifest 未宣告 → NULL
  // (update 時清掉先前存的 sheet)。validateStylesheet 是 REJECT-not-rewrite:見
  // stylesheet-guard.ts;第三方 CSS 於本站同源執行,故所有逃逸向量都擋在安裝時。
  let validatedStylesheet: string | null = null;
  if (manifest.stylesheet) {
    if (source === undefined) {
      // inline manifest 沒有 registry 來源,style.css 無處可抓。明確拒絕,
      // 不要靜默裝成「沒有 stylesheet」——那會讓 extension 少一塊卻無聲無息。
      return Response.json(
        {
          error: "invalid_stylesheet",
          message:
            "manifest declares `stylesheet` but was installed inline; a registry source is required to fetch it",
        },
        { status: 400 },
      );
    }
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

  // Ensure the committed revision always advances, even for two operations in
  // the same millisecond. The observed revision is claimed inside the batch.
  const tombstones = existingRows[0]
    ? []
    : await db()
        .select({ appliedAt: extMigrations.appliedAt })
        .from(extMigrations)
        .where(like(extMigrations.id, `${id}:install:%`))
        .orderBy(desc(extMigrations.appliedAt))
        .limit(1);
  const previousRevision: number | "new" = existingRows[0]
    ? existingRows[0].updatedAt
    : (tombstones[0]?.appliedAt ?? "new");
  const now =
    typeof previousRevision === "number"
      ? Math.max(Date.now(), previousRevision + 1)
      : Date.now();
  const promptedKeys = new Set(Object.keys(promptedValues));
  const secretKeys = new Set(
    (manifest.settings ?? [])
      .filter((field) => field.secret)
      .map((field) => `ext.${id}.${field.key}`),
  );
  const promptedEntries: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(promptedValues)) {
    promptedEntries[`ext.${id}.${key}`] = value;
  }

  const defaultEntries: Record<string, unknown> = {};
  for (const field of manifest.settings ?? []) {
    if (!promptedKeys.has(field.key)) {
      defaultEntries[`ext.${id}.${field.key}`] = field.default;
    }
  }

  let preparedPrompted: Record<string, string>;
  let preparedDefaults: Record<string, string>;
  let migrationItems: BatchItem<"sqlite">[];
  try {
    preparedPrompted = await prepareExtensionSettingValues(
      promptedEntries,
      secretKeys,
    );
    preparedDefaults = await prepareExtensionSettingValues(
      defaultEntries,
      secretKeys,
    );
    migrationItems = await buildDeclarativeMigrationBatch(
      id,
      manifest.migrations ?? [],
      now,
    );
  } catch (e) {
    return Response.json(
      {
        error: "install_prepare_failed",
        message: e instanceof Error ? e.message : "unknown error",
      },
      { status: 500 },
    );
  }

  // D1 batch has transaction semantics. Migrations + markers, manifest enable,
  // defaults and prompted settings now commit or roll back as one unit.
  const batch: BatchItem<"sqlite">[] = [
    buildInstallRevisionClaim(id, previousRevision, now),
    ...migrationItems,
  ];
  batch.push(
    db()
      .insert(dxTable)
      .values({
        id,
        manifest: JSON.stringify(manifest),
        version: manifest.version,
        enabled: 1,
        source: source ?? null,
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
          source: source ?? null,
          stylesheet: validatedStylesheet,
          updatedAt: now,
        },
      }),
  );
  for (const [key, value] of Object.entries(preparedDefaults)) {
    batch.push(
      db()
        .insert(settings)
        .values({
          key,
          value,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: settings.key }),
    );
  }
  for (const [key, value] of Object.entries(preparedPrompted)) {
    batch.push(
      db()
        .insert(settings)
        .values({ key, value, updatedAt: now })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedAt: now },
        }),
    );
  }

  try {
    await db().batch(
      batch as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
    );
  } catch (e) {
    const staleClaim = isStaleInstallConflict(e);
    return Response.json(
      {
        error: staleClaim ? "stale_install_conflict" : "install_commit_failed",
        message: e instanceof Error ? e.message : "unknown error",
      },
      { status: staleClaim ? 409 : 500 },
    );
  }

  // Commit 已成功;後續 cache/hook 是 best-effort，失敗不得把已完成的 install
  // 回報成 500(否則 client retry 會面臨 ambiguous committed state)。
  try {
    invalidateExtRuntimeMemo();
    invalidateSettingsCache();
    revalidateExt(id);
    const rt = await getExtRuntime();
    await rt.hooks.doAction("ext:enabled", id);
  } catch (e) {
    console.error(`[registry-install] post-commit refresh failed ext="${id}"`, e);
  }

  return Response.json({ ok: true, id, version: manifest.version });
}
