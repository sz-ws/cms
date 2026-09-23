import { getDB } from "@/lib/cf";
import {
  ExtensionLifecycleConflict,
  NO_GUARD,
  assertCodeDependencies,
  noDeclarativeDependents,
  requiredPluginsEnabled,
  writeCodeEnabled,
  writeCodeDisabled,
  type WriteGuard,
} from "./code-lifecycle";
import { and, eq, like, notLike, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db } from "@/lib/db";
import {
  extensions,
  extMigrations,
  settings,
  heartbeats,
  declarativeExtensions,
  contents,
} from "@/lib/schema";
import { registry } from "@/../extensions/registry";
import { invalidateSettingsCache } from "@/lib/settings";
import { getExtRuntime, invalidateExtRuntimeMemo } from "./loader";
import { revalidateExt } from "./dx/cache-invalidate";
import { CORE_API_VERSION } from "./version";
import { satisfies } from "./semver";
import type { Extension, ExtMigration } from "./types";
import { buildInstallRevisionClaim, installRevisionClaimId } from "./dx/declarative-migrate";
import { byId, listInstalledPlugins } from "./installed-plugins";
import { requiredBy, unmetRequirements, type PluginRequirement } from "./plugin-ref";
import { parseManifest } from "./dx/manifest";
import { getLocale } from "@/lib/i18n/server";
import { resolveLocalizedString } from "@/lib/i18n/localized";

// 03 §5:Manager — 啟用/停用/migrations。

export class ExtNotFound extends Error {
  constructor(extId: string) {
    super(`extension not found: ${extId}`);
  }
}

/** core-v2 §1:coreApi range 不相容 CORE_API_VERSION 時拒絕啟用。 */
export class CoreApiIncompatible extends Error {
  constructor(extId: string, range: string) {
    super(
      `extension "${extId}" requires coreApi "${range}" but core is ${CORE_API_VERSION}`,
    );
  }
}

function findManifest(extId: string): Extension {
  const ext = registry.find((e) => e.id === extId);
  if (!ext) throw new ExtNotFound(extId);
  return ext;
}

// ---- 1.45.0:啟用／套用更新的進度 ----
//
// 啟用一個 code extension 是四步:檢查相容與相依 → 套用還沒跑過的 migration → 寫入新設定
// 的預設值 → 記錄版本並通知其他插件。以前 API 全部做完才回一個 200,後台只能轉圈等。
// 現在四步各自是一個函式(enableStep*),後台一步打一次 API(api/extensions/[extId] 的
// action "enable-step"),畫面照實顯示走到哪一步、卡在哪一步。每一步都是完整的一個請求,
// D1、快取失效(revalidateTag)都在請求裡做完 —— 不用串流,也就沒有「回應送出後才執行」的問題。
//
// 已啟用的 extension 再跑一次 = 套用更新:已套用的 migration 會跳過、已存在的設定不覆寫,
// 所以中途失敗後重按一次是安全的。

export type EnableStepId = "check" | "migrate" | "settings" | "record";

export interface EnableStepEvent {
  step: EnableStepId;
  status: "running" | "done" | "skipped";
  /** migrate:正在套用／套用完的 migration id(每個 migration 各一組 running/done)。 */
  migration?: string;
  /** settings:這次新寫入幾個預設值。 */
  count?: number;
}

export type EnableProgress = (event: EnableStepEvent) => void;

/** 已啟用、但程式碼版本與資料庫紀錄不同,或有 migration 還沒套用的 code extension。 */
export interface PendingUpgrade {
  /** 資料庫記錄的版本(上次啟用時的版本)。 */
  from: string;
  /** 目前程式碼裡的版本。 */
  to: string;
  /** 還沒套用的 migration id,依宣告順序。 */
  migrations: string[];
}

/**
 * 1.45.0:列出待套用的更新。code extension 是編進程式碼的,部署新版後資料庫還停在舊版;
 * migration 只在 enable 時跑,所以要有人按「套用更新」(= 再 enable 一次)。
 */
export async function pendingCodeUpgrades(
  /** 呼叫端已經讀過 extensions 表就傳進來(省一次查詢)。 */
  known?: readonly { id: string; enabled: number; version: string }[],
): Promise<Map<string, PendingUpgrade>> {
  const [rows, applied] = await Promise.all([
    known ?? db().select({ id: extensions.id, enabled: extensions.enabled, version: extensions.version }).from(extensions),
    db().select({ id: extMigrations.id }).from(extMigrations),
  ]);
  const appliedIds = new Set(applied.map((r) => r.id));
  const out = new Map<string, PendingUpgrade>();
  for (const row of rows) {
    if (row.enabled !== 1) continue;
    const ext = registry.find((e) => e.id === row.id);
    if (!ext) continue;
    const migrations = (ext.migrations ?? [])
      .map((m) => m.id)
      .filter((id) => !appliedIds.has(`${ext.id}:${id}`));
    if (migrations.length === 0 && row.version === ext.version) continue;
    out.set(ext.id, { from: row.version, to: ext.version, migrations });
  }
  return out;
}

/** migration sql 以 ";" 切分,忽略空白 statement(03 §1:statement 內不得出現字面值分號)。 */
function splitStatements(sqlText: string): string[] {
  return sqlText
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 還沒套用的 migration id(<extId>:<migId> 不在 ext_migrations 裡),依宣告順序。 */
async function pendingMigrationIds(extId: string, migs: ExtMigration[]): Promise<string[]> {
  const applied = await db()
    .select({ id: extMigrations.id })
    .from(extMigrations)
    .where(eq(extMigrations.extId, extId));
  const appliedIds = new Set(applied.map((r) => r.id));
  return migs.filter((mig) => !appliedIds.has(`${extId}:${mig.id}`)).map((mig) => mig.id);
}

/**
 * 套用一個 migration(原子性,03 §5 步驟 2):sql 以 ";" 切分,連同「寫入 ext_migrations
 * 記錄」的 INSERT 一起組成一個 db.batch([...]) —— D1 batch 具交易語意,任一失敗整批 rollback。
 * 已套用過回 "skipped"。
 */
async function applyMigration(extId: string, mig: ExtMigration): Promise<"applied" | "skipped"> {
  const migKey = `${extId}:${mig.id}`;
  const done = await db()
    .select({ id: extMigrations.id })
    .from(extMigrations)
    .where(eq(extMigrations.id, migKey));
  if (done.length > 0) return "skipped";
  const items: BatchItem<"sqlite">[] = splitStatements(mig.sql).map((stmt) =>
    db().run(sql.raw(stmt)),
  );
  items.push(db().insert(extMigrations).values({ id: migKey, extId, appliedAt: Date.now() }));
  // batch 需要非空 tuple 型別。
  await db().batch(items as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return "applied";
}

// ---- 啟用的四步(1.45.0 起各自獨立,後台一步打一次 API;enableExtension 依序全跑)----

/** 1. 相容性與相依檢查;回傳還沒套用的 migration(後台據此列出要跑哪些)。 */
export async function enableStepCheck(extId: string): Promise<{ migrations: string[] }> {
  const ext = findManifest(extId);
  // core-v2 §1:coreApi 相容性檢查,不相容 → 拒絕(訊息可於 /admin/extensions 呈現)。
  if (!satisfies(CORE_API_VERSION, ext.coreApi)) {
    throw new CoreApiIncompatible(extId, ext.coreApi);
  }
  await assertCodeDependencies(getDB(), ext, registry);
  return { migrations: await pendingMigrationIds(extId, ext.migrations ?? []) };
}

/** 2. 套用一個 migration。id 必須是這個 extension 宣告過的。 */
export async function enableStepMigrate(
  extId: string,
  migrationId: string,
): Promise<"applied" | "skipped"> {
  const ext = findManifest(extId);
  const mig = (ext.migrations ?? []).find((m) => m.id === migrationId);
  if (!mig) throw new ExtNotFound(`${extId}:${migrationId}`);
  return applyMigration(extId, mig);
}

/** 3. 寫入預設 settings:settings 表還沒有的 ext.<extId>.<key> 才寫。回傳新寫入幾個。 */
export async function enableStepSettings(extId: string): Promise<number> {
  const ext = findManifest(extId);
  const now = Date.now();
  const existing = new Set(
    (
      await db()
        .select({ key: settings.key })
        .from(settings)
        .where(like(settings.key, `ext.${extId}.%`))
    ).map((r) => r.key),
  );
  let added = 0;
  for (const field of ext.settings ?? []) {
    const key = `ext.${extId}.${field.key}`;
    if (existing.has(key)) continue;
    await db()
      .insert(settings)
      .values({ key, value: JSON.stringify(field.default), updatedAt: now })
      .onConflictDoNothing({ target: settings.key });
    added += 1;
  }
  // 寫了預設 settings,失效 isolate settings 快取(同 isolate 立即生效)。
  if (added > 0) invalidateSettingsCache();
  return added;
}

/** 4. 記錄啟用與版本,失效快取,通知其他 extension。 */
export async function enableStepRecord(extId: string): Promise<void> {
  const ext = findManifest(extId);
  // upsert extensions 表:enabled=1, version, updated_at=now(首次同時填 installed_at)。
  // 硬規則:ON CONFLICT DO UPDATE 的 SET 子句不得包含 installed_at。
  await writeCodeEnabled(getDB(), ext, registry, Date.now());

  // memo 主動失效(belt-and-braces;跨 isolate 靠 stamp)。
  invalidateExtRuntimeMemo();
  invalidateSettingsCache();
  // 該 extension 的 public content cache 整批失效(enable 後結構/資料可能全變)。
  revalidateExt(extId);

  // hooks.doAction("ext:enabled", extId)
  // 已知行為(03 §5):此 HookBus 是「更新前」建好的(per-request cache),
  // 剛啟用的 extension 收不到自己的 ext:enabled;其他原本 enabled 的收得到。
  const rt = await getExtRuntime();
  await rt.hooks.doAction("ext:enabled", extId);
}

/** 一次跑完四步(安裝流程、agent tool 等不需要逐步顯示的呼叫端)。onStep 可旁聽每一步。 */
export async function enableExtension(
  extId: string,
  onStep: EnableProgress = () => {},
): Promise<void> {
  onStep({ step: "check", status: "running" });
  const { migrations } = await enableStepCheck(extId);
  onStep({ step: "check", status: "done" });

  if (migrations.length === 0) onStep({ step: "migrate", status: "skipped" });
  for (const id of migrations) {
    onStep({ step: "migrate", status: "running", migration: id });
    await enableStepMigrate(extId, id);
    onStep({ step: "migrate", status: "done", migration: id });
  }

  onStep({ step: "settings", status: "running" });
  const count = await enableStepSettings(extId);
  onStep({ step: "settings", status: "done", count });

  onStep({ step: "record", status: "running" });
  await enableStepRecord(extId);
  onStep({ step: "record", status: "done" });
}

export async function disableExtension(extId: string): Promise<void> {
  // update enabled=0 → doAction("ext:disabled")。不動資料表、不動 settings。
  const ext = findManifest(extId);
  // 1.50.0:需要它的插件(兩種都算)先擋一次、給名稱;writeCodeDisabled 的條件再擋一次競態。
  await assertNotRequired("code", extId);
  await writeCodeDisabled(getDB(), ext, registry, Date.now());

  invalidateExtRuntimeMemo();
  // 該 extension 的 public content cache 整批失效(disable 後不應再回舊資料)。
  revalidateExt(extId);

  const rt = await getExtRuntime();
  await rt.hooks.doAction("ext:disabled", extId);
}

export async function uninstallExtension(extId: string): Promise<void> {
  const ext = findManifest(extId);
  if (ext.canUninstall === false) throw new ExtensionLifecycleConflict("此插件保留帳務與訂單歷史，請使用停用功能");

  // 先 disable
  await disableExtension(extId);

  // 執行 ext.uninstall migrations(若有)
  for (const mig of ext.uninstall ?? []) {
    for (const stmt of splitStatements(mig.sql)) {
      await db().run(sql.raw(stmt));
    }
  }

  // 刪除該 ext 的 ext_migrations 記錄、settings 中 ext.<extId>.% 的 keys、extensions 列。
  await db().delete(extMigrations).where(eq(extMigrations.extId, extId));
  await db()
    .delete(settings)
    .where(like(settings.key, `ext.${extId}.%`));
  // 心跳(migrations/0018,如 cron 的 ext.cron.lastTick)以前跟著 settings 一起刪,
  // 搬家後照樣要刪。best-effort:觀測值刪不掉不該讓解除安裝半途失敗。
  try {
    await db()
      .delete(heartbeats)
      .where(like(heartbeats.key, `ext.${extId}.%`));
  } catch (e) {
    console.error("[ext] heartbeat cleanup failed", extId, e);
  }
  await db().delete(extensions).where(eq(extensions.id, extId));

  // disableExtension 已失效過一次,但其後的 getExtRuntime(fire hook)會用「僅停用」
  // 的狀態回填 memo;此處刪除 row 後需再失效一次。
  invalidateExtRuntimeMemo();
  // 上面刪了 ext.<id>.% 的 settings 列,失效 isolate settings 快取。
  invalidateSettingsCache();
}

// ---- declarative extensions(core-v2 §3.2/§3.3)----
// Phase C:僅 enable/disable 現有列(install/uninstall 的完整 registry 流程屬 Phase D)。
// declarative extension 無 DDL、無 migrations,啟停即切 enabled 欄位。

async function findDeclarativeRow(
  extId: string,
): Promise<{ id: string; updatedAt: number } | undefined> {
  const rows = await db()
    .select({
      id: declarativeExtensions.id,
      updatedAt: declarativeExtensions.updatedAt,
    })
    .from(declarativeExtensions)
    .where(eq(declarativeExtensions.id, extId))
    .limit(1);
  return rows[0];
}

/**
 * 切換 enabled。guard(1.50.0)是相依的最後一道檢查:它同時加在 revision claim 與
 * UPDATE 上,在同一個 batch 裡 —— 條件不成立時兩個都不寫。只擋 UPDATE 的話 claim 會
 * 留下來,之後同一個 revision 的每一次寫入都撞主鍵。回傳有沒有寫入。
 */
async function setDeclarativeEnabled(
  extId: string,
  enabled: 0 | 1,
  guard: WriteGuard = NO_GUARD,
): Promise<boolean> {
  const row = await findDeclarativeRow(extId);
  if (!row) throw new ExtNotFound(extId);
  const now = Math.max(Date.now(), row.updatedAt + 1);
  const d1 = getDB();
  const [, update] = await d1.batch([
    d1
      .prepare(`INSERT INTO ext_migrations (id, ext_id, applied_at) SELECT ?, ?, ? WHERE ${guard.sql}`)
      .bind(installRevisionClaimId(extId, row.updatedAt), extId, now, ...guard.binds),
    d1
      .prepare(`UPDATE declarative_extensions SET enabled = ?, updated_at = ? WHERE id = ? AND ${guard.sql}`)
      .bind(enabled, now, extId, ...guard.binds),
  ]);
  return update.meta.changes === 1;
}

// 讀出來的資料說可以、寫入時條件卻不成立:中間有人(另一個分頁)改了相關的插件。
const REQUIRED_JUST_DISABLED = "必要插件剛被停用，請重新整理後再試一次";
const DEPENDENT_JUST_ENABLED = "有其他插件剛啟用並需要它，請重新整理後再試一次";

/**
 * 1.50.0:停用或移除一個插件之前,啟用中、非選用地需要它的插件要先停用(與程式碼插件
 * 之間本來就有的規則相同,現在宣告式插件也算)。先用讀出來的資料擋,訊息給名稱;
 * 寫入時的條件(noDeclarativeDependents / writeCodeDisabled)再擋一次競態。
 * 回傳這個插件的 identity(寫入條件要用)。
 */
async function assertNotRequired(kind: "code" | "declarative", extId: string): Promise<string | null> {
  const plugins = await listInstalledPlugins(registry);
  const self = plugins.find((p) => p.kind === kind && p.id === extId);
  const identity = self?.identity ?? null;
  const dependents = requiredBy(plugins, { id: extId, identity });
  if (dependents.length === 0) return identity;
  const locale = await getLocale();
  const names = dependents.map((p) => resolveLocalizedString(p.name, locale) ?? p.id);
  throw new ExtensionLifecycleConflict(`這些插件需要它，請先停用：${names.join("、")}`);
}

/**
 * 1.50.0:宣告式插件 manifest.requiresExtensions 裡非選用的插件都要裝好、啟用。
 * 與程式碼插件的 assertCodeDependencies 同一種擋法(ExtensionLifecycleConflict → 409,
 * 訊息原樣顯示在擴充功能頁),但訊息用名稱 —— 已安裝列表上看得到的是名稱不是 id。
 * 回傳必要插件依種類分好的 id,給寫入時的條件(requiredPluginsEnabled)用。
 */
async function assertDeclarativeDependencies(
  extId: string,
): Promise<{ code: string[]; declarative: string[] }> {
  const rows = await db()
    .select({ manifest: declarativeExtensions.manifest })
    .from(declarativeExtensions)
    .where(eq(declarativeExtensions.id, extId))
    .limit(1);
  let requires: PluginRequirement[] = [];
  try {
    requires = parseManifest(JSON.parse(rows[0]?.manifest ?? "null")).manifest?.requiresExtensions ?? [];
  } catch {
    // manifest 讀不到:交給 loader 的健康檢查,這裡不擋啟用。
  }
  const none = { code: [], declarative: [] };
  if (!requires.some((req) => !req.optional)) return none;
  const installed = await listInstalledPlugins(registry);
  const installedById = byId(installed);
  const unmet = unmetRequirements(requires, installedById);
  if (unmet.length === 0) {
    const required = [...new Set(requires.filter((req) => !req.optional).map((req) => req.id))];
    return {
      code: required.filter((id) => installedById.get(id)?.kind === "code"),
      declarative: required.filter((id) => installedById.get(id)?.kind === "declarative"),
    };
  }
  const locale = await getLocale();
  const nameOf = (id: string) =>
    resolveLocalizedString(installed.find((p) => p.id === id)?.name, locale) ?? id;
  // 沒裝(或同 id 是別的插件)只能給 id;停用的插件看得到名稱。
  const toInstall = unmet.filter((u) => u.state !== "disabled").map((u) => u.id);
  const toEnable = unmet.filter((u) => u.state === "disabled").map((u) => nameOf(u.id));
  throw new ExtensionLifecycleConflict(
    [
      toInstall.length > 0 ? `請先安裝必要插件：${toInstall.join("、")}` : null,
      toEnable.length > 0 ? `請先啟用必要插件：${toEnable.join("、")}` : null,
    ]
      .filter(Boolean)
      .join("；"),
  );
}

export async function enableDeclarative(extId: string): Promise<void> {
  const required = await assertDeclarativeDependencies(extId);
  if (!(await setDeclarativeEnabled(extId, 1, requiredPluginsEnabled(required)))) {
    throw new ExtensionLifecycleConflict(REQUIRED_JUST_DISABLED);
  }
  invalidateExtRuntimeMemo();
  const rt = await getExtRuntime();
  await rt.hooks.doAction("ext:enabled", extId);
}

/** 停用,條件是沒有啟用中的插件需要它(先擋一次給名稱,寫入時再擋一次)。 */
async function disableDeclarativeGuarded(extId: string): Promise<void> {
  const identity = await assertNotRequired("declarative", extId);
  if (!(await setDeclarativeEnabled(extId, 0, noDeclarativeDependents(extId, identity)))) {
    throw new ExtensionLifecycleConflict(DEPENDENT_JUST_ENABLED);
  }
}

export async function disableDeclarative(extId: string): Promise<void> {
  await disableDeclarativeGuarded(extId);
  invalidateExtRuntimeMemo();
  const rt = await getExtRuntime();
  await rt.hooks.doAction("ext:disabled", extId);
}

/**
 * core-v2 §3.4 Phase D:declarative uninstall。刪除 declarative_extensions 列 +
 * 其 settings(ext.<extId>.%),purgeContent=true 時一併刪除 contents 中
 * type LIKE "<extId>.%" 的列(該 extension 的所有 content type)。
 * 先 disable(fire ext:disabled)再刪除,與 code uninstallExtension 對稱。
 *
 * 1.50.0:先停用這一步帶著「沒有啟用中的插件需要它」的條件。停用之後,需要它的插件
 * 就啟用不了(它們啟用的條件是它啟用中),所以接下來的刪除不會剛好碰上有人又用上它。
 */
export async function uninstallDeclarative(
  extId: string,
  purgeContent: boolean,
): Promise<void> {
  await disableDeclarativeGuarded(extId);
  const row = await findDeclarativeRow(extId);
  if (!row) throw new ExtNotFound(extId);
  const rt = await getExtRuntime();
  const now = Math.max(Date.now(), row.updatedAt + 1);
  const batch: BatchItem<"sqlite">[] = [
    buildInstallRevisionClaim(extId, row.updatedAt, now),
    db()
      .delete(settings)
      .where(like(settings.key, `ext.${extId}.%`)),
    db()
      .delete(extMigrations)
      .where(
        and(
          eq(extMigrations.extId, extId),
          notLike(extMigrations.id, `${extId}:install:%`),
        ),
      ),
    db()
      .delete(declarativeExtensions)
      .where(eq(declarativeExtensions.id, extId)),
  ];
  if (purgeContent) {
    batch.splice(
      batch.length - 1,
      0,
      db().delete(contents).where(like(contents.type, `${extId}.%`)),
    );
  }
  await db().batch(
    batch as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
  );

  // 同 uninstallExtension:disableDeclarative 後的 getExtRuntime 會回填 memo,刪 row 後再失效。
  invalidateExtRuntimeMemo();
  // 上面刪了 ext.<id>.% 的 settings 列,失效 isolate settings 快取。
  invalidateSettingsCache();
  revalidateExt(extId);
  await rt.hooks.doAction("ext:disabled", extId);
}
