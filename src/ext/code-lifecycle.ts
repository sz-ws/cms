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
  const declarative = noDeclarativeDependents(ext.id, ext.identity ?? null);
  const result = await db.prepare(`UPDATE extensions SET enabled = 0, updated_at = ? WHERE id = ?
    AND NOT EXISTS (SELECT 1 FROM extensions WHERE enabled = 1 AND id IN (SELECT value FROM json_each(?)))
    AND ${declarative.sql}
    AND (${ext.canDisable?.sql ?? "1"})`)
    .bind(at, ext.id, JSON.stringify(dependents), ...declarative.binds).run();
  if (result.meta.changes !== 1) throw new ExtensionLifecycleConflict(ext.canDisable?.message ? `無法停用：${ext.canDisable.message}，或仍有其他插件依賴它。` : "尚有啟用中的插件依賴此插件");
}

// ---- 1.50.0:宣告式插件的相依,寫入時的最後一道 ----
//
// 與上面兩個函式同一種做法:條件寫進寫入的那一條 SQL(或同一個 batch 裡的每一條),
// 讀和寫之間沒有空檔。呼叫端先用讀出來的資料擋一次、給出有名稱的訊息;這裡擋的是那
// 之後才發生的變化(另一個分頁剛好停用了必要插件)。

/** 一段 WHERE 條件和它的參數,依序接在寫入語句自己的參數後面。 */
export interface WriteGuard {
  sql: string;
  binds: (string | number | null)[];
}

export const NO_GUARD: WriteGuard = { sql: "1", binds: [] };

/** 這些插件此刻都啟用中(程式碼插件看 extensions,宣告式看 declarative_extensions)。 */
export function requiredPluginsEnabled(required: { code: readonly string[]; declarative: readonly string[] }): WriteGuard {
  const parts: WriteGuard[] = [];
  const count = (table: string, ids: readonly string[]): WriteGuard => ({
    sql: `(SELECT COUNT(*) FROM ${table} WHERE enabled = 1 AND id IN (SELECT value FROM json_each(?))) = ?`,
    binds: [JSON.stringify(ids), ids.length],
  });
  if (required.code.length > 0) parts.push(count("extensions", required.code));
  if (required.declarative.length > 0) parts.push(count("declarative_extensions", required.declarative));
  if (parts.length === 0) return NO_GUARD;
  return { sql: parts.map((p) => p.sql).join(" AND "), binds: parts.flatMap((p) => p.binds) };
}

/**
 * 沒有啟用中的宣告式插件非選用地需要 (id, identity) 這個插件。identity 的比法同
 * plugin-ref 的 requirementState:兩邊都有 identity 而且不同,就不是在說它。
 *
 * manifest 安裝時已經驗過,但這條條件擋在每一次停用的路上 —— 一列手動改壞的 manifest
 * 讓 json_each 丟錯,就會讓整站什麼都停用不了。所以每一步取值都先確認形狀(CASE 只
 * 算選中的那一支):不是合法 JSON、requiresExtensions 不是陣列、元素不是物件,都當作
 * 沒有相依。
 */
export function noDeclarativeDependents(id: string, identity: string | null): WriteGuard {
  const reqs = `COALESCE(CASE WHEN json_valid(d.manifest) THEN CASE json_type(d.manifest, '$.requiresExtensions') WHEN 'array' THEN json_extract(d.manifest, '$.requiresExtensions') END END, '[]')`;
  const field = (key: string) => `CASE WHEN r.type = 'object' THEN json_extract(r.value, '$.${key}') END`;
  return {
    sql: `NOT EXISTS (SELECT 1 FROM declarative_extensions d, json_each(${reqs}) r
      WHERE d.enabled = 1 AND d.id <> ?
        AND ${field("id")} = ?
        AND COALESCE(${field("optional")}, 0) = 0
        AND (${field("identity")} IS NULL OR ? IS NULL OR ${field("identity")} = ?))`,
    binds: [id, id, identity, identity],
  };
}
