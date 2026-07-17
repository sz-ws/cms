import { eq, like, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db } from "@/lib/db";
import {
  extensions,
  extMigrations,
  settings,
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

/** migration sql 以 ";" 切分,忽略空白 statement(03 §1:statement 內不得出現字面值分號)。 */
function splitStatements(sqlText: string): string[] {
  return sqlText
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 執行未套用的 migrations(原子性,03 §5 步驟 2)。
 * 對每一項未記錄的 migration:將 sql 以 ";" 切分,連同「寫入 ext_migrations 記錄」的
 * INSERT 一起組成一個 db.batch([...]) 呼叫——D1 batch 具交易語意,任一失敗整批 rollback。
 */
async function runMigrations(
  extId: string,
  migs: ExtMigration[],
): Promise<void> {
  // 查已套用的 migration 記錄(<extId>:<migId> 作為 ext_migrations.id)。
  const applied = await db()
    .select({ id: extMigrations.id })
    .from(extMigrations)
    .where(eq(extMigrations.extId, extId));
  const appliedIds = new Set(applied.map((r) => r.id));

  for (const mig of migs) {
    const migKey = `${extId}:${mig.id}`;
    if (appliedIds.has(migKey)) continue;

    const statements = splitStatements(mig.sql);
    const items: BatchItem<"sqlite">[] = statements.map((stmt) =>
      db().run(sql.raw(stmt)),
    );
    // 連同 ext_migrations 記錄一起 batch,任一失敗整批 rollback。
    items.push(
      db().insert(extMigrations).values({
        id: migKey,
        extId,
        appliedAt: Date.now(),
      }),
    );
    // batch 需要非空 tuple 型別。
    await db().batch(items as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }
}

export async function enableExtension(extId: string): Promise<void> {
  // 1. 從 registry 找 manifest,找不到 → throw ExtNotFound
  const ext = findManifest(extId);

  // 1b. core-v2 §1:coreApi 相容性檢查,不相容 → 拒絕(訊息可於 /admin/extensions 呈現)。
  if (!satisfies(CORE_API_VERSION, ext.coreApi)) {
    throw new CoreApiIncompatible(extId, ext.coreApi);
  }

  // 2. 執行未套用的 migrations(原子性)
  await runMigrations(extId, ext.migrations ?? []);

  // 3. 寫入預設 settings:對 ext.settings 每項,若 settings 表無 ext.<extId>.<key> → insert default
  const now = Date.now();
  for (const field of ext.settings ?? []) {
    const key = `ext.${extId}.${field.key}`;
    await db()
      .insert(settings)
      .values({ key, value: JSON.stringify(field.default), updatedAt: now })
      .onConflictDoNothing({ target: settings.key });
  }

  // 4. upsert extensions 表:enabled=1, version, updated_at=now(首次同時填 installed_at)。
  //    硬規則:ON CONFLICT DO UPDATE 的 SET 子句不得包含 installed_at。
  await db()
    .insert(extensions)
    .values({
      id: extId,
      enabled: 1,
      version: ext.version,
      installedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: extensions.id,
      set: { enabled: 1, version: ext.version, updatedAt: now },
    });

  // memo 主動失效(belt-and-braces;跨 isolate 靠 stamp)。
  invalidateExtRuntimeMemo();
  // 步驟 3 寫了預設 settings,失效 isolate settings 快取(同 isolate 立即生效)。
  invalidateSettingsCache();
  // 該 extension 的 public content cache 整批失效(enable 後結構/資料可能全變)。
  revalidateExt(extId);

  // 5. hooks.doAction("ext:enabled", extId)
  // 已知行為(03 §5):此 HookBus 是「更新前」建好的(per-request cache),
  // 剛啟用的 extension 收不到自己的 ext:enabled;其他原本 enabled 的收得到。
  const rt = await getExtRuntime();
  await rt.hooks.doAction("ext:enabled", extId);
}

export async function disableExtension(extId: string): Promise<void> {
  // update enabled=0 → doAction("ext:disabled")。不動資料表、不動 settings。
  findManifest(extId); // 不存在 → ExtNotFound
  await db()
    .update(extensions)
    .set({ enabled: 0, updatedAt: Date.now() })
    .where(eq(extensions.id, extId));

  invalidateExtRuntimeMemo();
  // 該 extension 的 public content cache 整批失效(disable 後不應再回舊資料)。
  revalidateExt(extId);

  const rt = await getExtRuntime();
  await rt.hooks.doAction("ext:disabled", extId);
}

export async function uninstallExtension(extId: string): Promise<void> {
  const ext = findManifest(extId);

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
): Promise<{ id: string } | undefined> {
  const rows = await db()
    .select({ id: declarativeExtensions.id })
    .from(declarativeExtensions)
    .where(eq(declarativeExtensions.id, extId))
    .limit(1);
  return rows[0];
}

export async function enableDeclarative(extId: string): Promise<void> {
  if (!(await findDeclarativeRow(extId))) throw new ExtNotFound(extId);
  await db()
    .update(declarativeExtensions)
    .set({ enabled: 1, updatedAt: Date.now() })
    .where(eq(declarativeExtensions.id, extId));
  invalidateExtRuntimeMemo();
  const rt = await getExtRuntime();
  await rt.hooks.doAction("ext:enabled", extId);
}

export async function disableDeclarative(extId: string): Promise<void> {
  if (!(await findDeclarativeRow(extId))) throw new ExtNotFound(extId);
  await db()
    .update(declarativeExtensions)
    .set({ enabled: 0, updatedAt: Date.now() })
    .where(eq(declarativeExtensions.id, extId));
  invalidateExtRuntimeMemo();
  const rt = await getExtRuntime();
  await rt.hooks.doAction("ext:disabled", extId);
}

/**
 * core-v2 §3.4 Phase D:declarative uninstall。刪除 declarative_extensions 列 +
 * 其 settings(ext.<extId>.%),purgeContent=true 時一併刪除 contents 中
 * type LIKE "<extId>.%" 的列(該 extension 的所有 content type)。
 * 先 disable(fire ext:disabled)再刪除,與 code uninstallExtension 對稱。
 */
export async function uninstallDeclarative(
  extId: string,
  purgeContent: boolean,
): Promise<void> {
  if (!(await findDeclarativeRow(extId))) throw new ExtNotFound(extId);

  await disableDeclarative(extId);

  await db()
    .delete(settings)
    .where(like(settings.key, `ext.${extId}.%`));

  if (purgeContent) {
    await db().delete(contents).where(like(contents.type, `${extId}.%`));
  }

  await db()
    .delete(declarativeExtensions)
    .where(eq(declarativeExtensions.id, extId));

  // 同 uninstallExtension:disableDeclarative 後的 getExtRuntime 會回填 memo,刪 row 後再失效。
  invalidateExtRuntimeMemo();
  // 上面刪了 ext.<id>.% 的 settings 列,失效 isolate settings 快取。
  invalidateSettingsCache();
}
