import { sql } from "drizzle-orm";
import type { ApiCtx } from "../types";
import type { CoreServices } from "../services";
import type { OrderStatus } from "./types";
import type { TransitionExtras } from "./orders";

/** Opt-in transactional commerce. Existing shops continue on the legacy path.
 * A persisted managed marker can NEVER fall back to a non-transactional update.
 */
export interface ManagedCommerceProvider {
  checkout(req: Request, ctx: ApiCtx): Promise<Response>;
  transition(orderNo: string, to: OrderStatus, extras: TransitionExtras): Promise<boolean>;
}

export async function resolveManagedOrder(deps: Pick<CoreServices, "db">, table: string, orderNo: string): Promise<ManagedCommerceProvider | null> {
  if (!/^[a-z][a-z0-9_]{2,60}$/.test(table)) throw new Error("invalid order table");
  const marker = `${table}_managed`;
  // sqlite_master check keeps unmodified/older stores compatible without swallowing DB failures.
  const exists = await deps.db.get<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${marker}`);
  if (!exists) return null;
  const row = await deps.db.get<{ order_no: string }>(sql`SELECT order_no FROM ${sql.raw(marker)} WHERE order_no = ${orderNo}`);
  if (!row) return null;
  const { createServices } = await import("../services");
  const services = await createServices("shop");
  const provider = services.providers.getById<ManagedCommerceProvider>("commerce:orders", table);
  if (!provider) throw new Error("managed commerce provider unavailable; refusing legacy order mutation");
  return provider;
}
