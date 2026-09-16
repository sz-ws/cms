import { formatUnits } from "./amount";
import { checkedText, copyAccount, copyOwner, positiveUnits, prepareOperation } from "./operations";
import { ledgerTables } from "./schema";
import type { LedgerAccount, LedgerBalance, LedgerEntry, LedgerOperation, LedgerOwner, LedgerReservation, ReservationState } from "./types";

type Counters = { available: number; held: number; consumed: number; credited: number; adjusted: number };

/** Low-level, server-only provider. Authorization belongs to the calling extension. */
export function createLedgerProvider(db: D1Database, prefix: string) {
  const t = ledgerTables(prefix);
  const identity = `a.id = ? AND a.owner_type = ? AND a.owner_id = ? AND a.unit = ? AND a.precision = ?`;
  const args = (account: LedgerAccount) => {
    const a = copyAccount(account);
    return [a.id, a.owner.type, a.owner.id, a.unit, a.precision];
  };
  const balance = (row: Counters, a: LedgerAccount): LedgerBalance => ({
    available: formatUnits(row.available, a.precision),
    held: formatUnits(row.held, a.precision),
    consumed: formatUnits(row.consumed, a.precision),
    credited: formatUnits(row.credited - row.adjusted, a.precision),
    adjusted: formatUnits(row.adjusted, a.precision),
    unit: a.unit,
    precision: a.precision,
  });
  const transition = (kind: "capture" | "release" | "refund", account: LedgerAccount, reservationId: string) =>
    prepareOperation(db, prefix, { kind, account: copyAccount(account), reservationId: checkedText(reservationId, "reservation id") });

  return {
    prepareOpen(account: LedgerAccount): LedgerOperation {
      return prepareOperation(db, prefix, { kind: "open", account: copyAccount(account) });
    },
    prepareCredit(account: LedgerAccount, amount: string): LedgerOperation {
      const a = copyAccount(account);
      return prepareOperation(db, prefix, { kind: "credit", account: a, units: positiveUnits(amount, a.precision) });
    },
    prepareAdjustment(account: LedgerAccount, amount: string): LedgerOperation {
      const a = copyAccount(account);
      if (typeof amount !== "string") throw new Error("adjustment must be a decimal string");
      const negative = amount.startsWith("-");
      const units = positiveUnits(negative ? amount.slice(1) : amount.startsWith("+") ? amount.slice(1) : amount, a.precision) * (negative ? -1 : 1);
      return prepareOperation(db, prefix, { kind: "adjust", account: a, units });
    },
    prepareReserve(account: LedgerAccount, reservationId: string, amount: string, source: LedgerOwner): LedgerOperation {
      const a = copyAccount(account);
      return prepareOperation(db, prefix, {
        kind: "reserve", account: a, units: positiveUnits(amount, a.precision),
        reservationId: checkedText(reservationId, "reservation id"), source: copyOwner(source),
      });
    },
    prepareCapture: (account: LedgerAccount, reservationId: string) => transition("capture", account, reservationId),
    prepareRelease: (account: LedgerAccount, reservationId: string) => transition("release", account, reservationId),
    /** Full refund only. Inventory callers must establish that goods can be restocked. */
    prepareRefund: (account: LedgerAccount, reservationId: string) => transition("refund", account, reservationId),

    async getBalance(account: LedgerAccount): Promise<LedgerBalance | null> {
      const a = copyAccount(account);
      const row = await db.prepare(`SELECT a.available, a.held, a.consumed, a.credited, a.adjusted FROM ${t.accounts} a WHERE ${identity}`)
        .bind(...args(a)).first<Counters>();
      return row ? balance(row, a) : null;
    },
    async getReservation(account: LedgerAccount, reservationId: string): Promise<LedgerReservation | null> {
      const a = copyAccount(account);
      const row = await db.prepare(`SELECT r.id, r.units, r.state, r.source_type, r.source_id
        FROM ${t.reservations} r JOIN ${t.accounts} a ON a.id = r.account_id WHERE ${identity} AND r.id = ?`)
        .bind(...args(a), checkedText(reservationId, "reservation id"))
        .first<{ id: string; units: number; state: ReservationState; source_type: string; source_id: string }>();
      return row ? { id: row.id, amount: formatUnits(row.units, a.precision), state: row.state, source: { type: row.source_type, id: row.source_id } } : null;
    },
    async listEntries(account: LedgerAccount, options: { limit?: number; offset?: number } = {}): Promise<LedgerEntry[]> {
      const a = copyAccount(account);
      const limit = options.limit ?? 50;
      const offset = options.offset ?? 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid ledger pagination");
      type EntryRow = {
        id: string; operation_id: string; kind: LedgerEntry["kind"]; reservation_id: string | null;
        available_before: number; held_before: number; consumed_before: number; credited_before: number; adjusted_before: number;
        available_after: number; held_after: number; consumed_after: number; credited_after: number; adjusted_after: number;
        actor_type: string; actor_id: string; reason: string; created_at: number;
      };
      const rows = await db.prepare(`SELECT l.*, o.actor_type, o.actor_id, o.reason
        FROM ${t.ledger} l JOIN ${t.accounts} a ON a.id = l.account_id
        JOIN ${t.operations} o ON o.id = l.operation_id WHERE ${identity}
        ORDER BY l.created_at DESC, l.rowid DESC LIMIT ? OFFSET ?`)
        .bind(...args(a), limit, offset).all<EntryRow>();
      return rows.results.map((r) => ({
        id: r.id, operationId: r.operation_id, kind: r.kind, reservationId: r.reservation_id,
        before: balance({ available: r.available_before, held: r.held_before, consumed: r.consumed_before, credited: r.credited_before, adjusted: r.adjusted_before }, a),
        after: balance({ available: r.available_after, held: r.held_after, consumed: r.consumed_after, credited: r.credited_after, adjusted: r.adjusted_after }, a),
        actor: { type: r.actor_type, id: r.actor_id }, reason: r.reason, createdAt: r.created_at,
      }));
    },
  };
}
