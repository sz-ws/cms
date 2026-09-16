import type { Extension } from "./types";

export class ExtensionLifecycleConflict extends Error {}

export async function assertCodeDependencies(db: D1Database, ext: Extension, registry: readonly Extension[]) {
  const ids = ext.requiresExtensions ?? [];
  if (ids.some((id) => !registry.some((entry) => entry.id === id))) throw new ExtensionLifecycleConflict(`請先安裝必要插件：${ids.join(", ")}`);
  const row = await db.prepare("SELECT COUNT(*) AS n FROM extensions WHERE enabled = 1 AND id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).first<{ n: number }>();
  if (row?.n !== ids.length) throw new ExtensionLifecycleConflict(`請先啟用必要插件：${ids.join(", ")}`);
}

/** Final dependency check and enabled write share one statement, closing races. */
export async function writeCodeEnabled(db: D1Database, ext: Extension, registry: readonly Extension[], at: number) {
  await assertCodeDependencies(db, ext, registry);
  const ids = ext.requiresExtensions ?? [];
  const result = await db.prepare(`INSERT INTO extensions (id, enabled, version, installed_at, updated_at)
    SELECT ?, 1, ?, ?, ? WHERE (SELECT COUNT(*) FROM extensions WHERE enabled = 1 AND id IN (SELECT value FROM json_each(?))) = ?
    ON CONFLICT(id) DO UPDATE SET enabled = 1, version = excluded.version, updated_at = excluded.updated_at`)
    .bind(ext.id, ext.version, at, at, JSON.stringify(ids), ids.length).run();
  if (result.meta.changes !== 1) throw new ExtensionLifecycleConflict("必要插件已停用，請重新確認");
}

/** No asynchronous guard callback can accidentally leave a read/write gap. */
export async function writeCodeDisabled(db: D1Database, ext: Extension, registry: readonly Extension[], at: number) {
  const present = await db.prepare("SELECT id FROM extensions WHERE id = ?").bind(ext.id).first();
  if (!present) return;
  const dependents = registry.filter((entry) => entry.requiresExtensions?.includes(ext.id)).map((entry) => entry.id);
  const result = await db.prepare(`UPDATE extensions SET enabled = 0, updated_at = ? WHERE id = ?
    AND NOT EXISTS (SELECT 1 FROM extensions WHERE enabled = 1 AND id IN (SELECT value FROM json_each(?)))
    AND (${ext.canDisable?.sql ?? "1"})`)
    .bind(at, ext.id, JSON.stringify(dependents)).run();
  if (result.meta.changes !== 1) throw new ExtensionLifecycleConflict(ext.canDisable?.message ? `無法停用：${ext.canDisable.message}，或仍有其他插件依賴它。` : "尚有啟用中的插件依賴此插件");
}
