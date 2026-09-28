import { sql } from "drizzle-orm";
import type { CommerceDb } from "./orders";

/**
 * @deprecated 1.63.0 — remove in 2.0.
 *
 * 1.63.0 以前,接手訂單的插件用一張 `<訂單表>_managed` 表標記它管的訂單,core 查那張表決定一筆訂單
 * 歸誰。1.63.0 起看訂單列的 managed_by 欄(shop migration 0007,接手的插件下單時寫、它的 migration
 * 把舊訂單補上)。站台部署了新版、還沒按「套用更新」時,managed_by 欄還沒有或還是空的 —— 這段照舊
 * 查那張表,結帳與轉移和以前一樣。2.0 拿掉,屆時只看 managed_by。
 */

const TABLE_RE = /^[a-z][a-z0-9_]{2,60}$/;

function legacyTable(table: string): string {
  if (!TABLE_RE.test(table)) throw new Error("invalid order table");
  return `${table}_managed`;
}

async function legacyTableExists(deps: CommerceDb, marker: string): Promise<boolean> {
  const row = await deps.db.get<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${marker}`,
  );
  return row !== undefined && row !== null;
}

/** 有舊的標記表(以前接手過訂單):沒有插件接手時,結帳要暫停,和以前一樣。 */
export async function legacyManagedTable(deps: CommerceDb, table: string): Promise<boolean> {
  return legacyTableExists(deps, legacyTable(table));
}

/** 這筆訂單在舊的標記表裡。 */
export async function legacyManagedOrder(deps: CommerceDb, table: string, orderNo: string): Promise<boolean> {
  const marker = legacyTable(table);
  if (!(await legacyTableExists(deps, marker))) return false;
  const row = await deps.db.get<{ order_no: string }>(
    sql`SELECT order_no FROM ${sql.raw(marker)} WHERE order_no = ${orderNo}`,
  );
  return row !== undefined && row !== null;
}
