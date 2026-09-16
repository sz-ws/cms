import { checkedText, copyOwner, readOperation, type LedgerAction } from "./operations";
import { appendTransaction } from "./transaction";
import { ledgerTables } from "./schema";
import type { LedgerCommand, LedgerOperation } from "./types";

export class LedgerConflict extends Error {
  constructor(public readonly code: "idempotency_conflict" | "precondition_failed") {
    super(code);
    this.name = "LedgerConflict";
  }
}

/**
 * One batch for all participants. D1 CHECK failures abort the whole batch;
 * zero-row UPDATE alone is never treated as proof of a valid transition.
 * This server-only API performs no authentication and exposes no HTTP route.
 */
export async function commitLedgerOperations(
  command: LedgerCommand,
  operations: readonly LedgerOperation[],
): Promise<{ status: "applied" | "replayed" }> {
  const id = checkedText(command.id, "command id");
  const actor = copyOwner(command.actor);
  const reason = checkedText(command.reason, "reason", 500);
  if (operations.length === 0 || operations.length > 50) throw new Error("expected 1–50 ledger operations");
  const plans = operations.map(readOperation);
  const db = plans[0].db;
  if (plans.some((p) => p.db !== db)) throw new Error("all participants must use the same D1 binding");
  const canonical = JSON.stringify({ version: 1, id, actor, reason, plans: plans.map(({ prefix, action }) => ({ prefix, action })) });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const fingerprint = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  const claim = crypto.randomUUID();
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  const prefixes = [...new Set(plans.map((p) => p.prefix))];

  for (const prefix of prefixes) {
    const t = ledgerTables(prefix);
    // Only the winning insert owns `claim`. An exact replay retains the old claim;
    // every following write is gated by that claim and therefore becomes a no-op.
    statements.push(db.prepare(`INSERT INTO ${t.operations}
      (id, fingerprint, claim, actor_type, actor_id, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET matches = CASE WHEN fingerprint = excluded.fingerprint THEN 1 ELSE 0 END`)
      .bind(id, fingerprint, claim, actor.type, actor.id, reason, now));
  }

  // All participant receipts must be new together or replayed together. Check
  // inside the transaction, including recovery from externally deleted receipts.
  const claimedCounts = prefixes.map((prefix) =>
    `(SELECT COUNT(*) FROM ${ledgerTables(prefix).operations} WHERE id = (SELECT id FROM command) AND claim = (SELECT claim FROM command))`);
  statements.push(db.prepare(`WITH command(id, claim) AS (VALUES (?, ?))
    UPDATE ${ledgerTables(prefixes[0]).operations}
    SET valid = CASE WHEN (${claimedCounts.join(" + ")}) IN (0, ${prefixes.length}) THEN 1 ELSE 0 END
    WHERE id = ?`).bind(id, claim, id));

  for (const [index, { prefix, action }] of plans.entries()) {
    appendAction(db, statements, prefix, action, { id, claim, now, index });
  }
  // Read back within the same batch, so no competing command changes this result.
  for (const prefix of prefixes) {
    statements.push(db.prepare(`SELECT claim FROM ${ledgerTables(prefix).operations} WHERE id = ?`).bind(id));
  }
  try {
    const results = await db.batch<{ claim: string }>(statements);
    const receipts = results.slice(-prefixes.length);
    const applied = receipts.map((r) => r.results[0]?.claim === claim);
    // Partial receipt loss indicates external data corruption, not a valid replay.
    // Guarded in-batch before any action, so this is a defensive assertion.
    if (applied.some(Boolean) && !applied.every(Boolean)) throw new Error("inconsistent ledger receipts");
    return { status: applied[0] ? "applied" : "replayed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ledger_idempotency")) throw new LedgerConflict("idempotency_conflict");
    if (message.includes("ledger_precondition")) throw new LedgerConflict("precondition_failed");
    throw error;
  }
}

function appendAction(
  db: D1Database,
  statements: D1PreparedStatement[],
  prefix: string,
  action: LedgerAction,
  ctx: { id: string; claim: string; now: number; index: number },
) {
  const t = ledgerTables(prefix);
  const { id, claim, now, index } = ctx;
  if (action.kind === "transaction") {
    appendTransaction(db, statements, prefix, action.mutations, id, claim);
    return;
  }
  const a = action.account;
  const active = `EXISTS (SELECT 1 FROM ${t.operations} WHERE id = ? AND claim = ?)`;
  const identity = `a.id = ? AND a.owner_type = ? AND a.owner_id = ? AND a.unit = ? AND a.precision = ?`;
  const identityArgs = [a.id, a.owner.type, a.owner.id, a.unit, a.precision];
  const guard = (condition: string, args: (string | number)[]) => {
    statements.push(db.prepare(`UPDATE ${t.operations} SET valid = CASE WHEN ${condition} THEN 1 ELSE 0 END WHERE id = ? AND claim = ?`)
      .bind(...args, id, claim));
  };
  if (action.kind === "open") {
    guard(`NOT EXISTS (SELECT 1 FROM ${t.accounts} WHERE id = ? OR (owner_type = ? AND owner_id = ? AND unit = ?))`, [a.id, a.owner.type, a.owner.id, a.unit]);
    statements.push(db.prepare(`INSERT INTO ${t.accounts} (id, owner_type, owner_id, unit, precision, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE ${active}`).bind(...identityArgs, now, id, claim));
    return;
  }

  let amount: string;
  let reservationId: string | null = null;
  if (action.kind === "credit" || action.kind === "adjust" || action.kind === "reserve") {
    amount = String(action.units); // validated positive safe integer, never arbitrary SQL
    guard(`EXISTS (SELECT 1 FROM ${t.accounts} a WHERE ${identity})`, identityArgs);
    if (action.kind === "reserve") {
      reservationId = action.reservationId;
      guard(`NOT EXISTS (SELECT 1 FROM ${t.reservations} WHERE id = ?)`, [reservationId]);
      guard(`EXISTS (SELECT 1 FROM ${t.accounts} WHERE id = ? AND available >= ?)`, [a.id, action.units]);
      statements.push(db.prepare(`INSERT INTO ${t.reservations}
        (id, account_id, units, source_type, source_id, state, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, 'held', ?, ? WHERE ${active}`)
        .bind(reservationId, a.id, action.units, action.source.type, action.source.id, now, now, id, claim));
    } else if (action.kind === "adjust") {
      guard(`EXISTS (SELECT 1 FROM ${t.accounts} WHERE id = ? AND available + (?) >= 0 AND credited + (?) BETWEEN 0 AND 9007199254740991 AND adjusted + (?) BETWEEN -9007199254740991 AND 9007199254740991)`, [a.id, action.units, action.units, action.units]);
    } else {
      guard(`EXISTS (SELECT 1 FROM ${t.accounts} WHERE id = ? AND credited <= 9007199254740991 - ? AND credited - adjusted <= 9007199254740991 - ?)`, [a.id, action.units, action.units]);
    }
  } else {
    reservationId = action.reservationId;
    const expectedState = action.kind === "refund" ? "captured" : "held";
    guard(`EXISTS (SELECT 1 FROM ${t.accounts} a JOIN ${t.reservations} r ON r.account_id = a.id
      WHERE ${identity} AND r.id = ? AND r.state = ?)`, [...identityArgs, reservationId, expectedState]);
    // ID is bound using a subquery parameter below by joining the reservation.
    amount = "r.units";
  }

  const deltas = {
    credit: [amount, "0", "0", amount, "0"],
    adjust: [amount, "0", "0", amount, amount],
    reserve: [`-${amount}`, amount, "0", "0", "0"],
    capture: ["0", `-${amount}`, amount, "0", "0"],
    release: [amount, `-${amount}`, "0", "0", "0"],
    refund: [amount, "0", `-${amount}`, "0", "0"],
  }[action.kind];
  const keys = ["available", "held", "consumed", "credited", "adjusted"];
  const usesReservation = amount === "r.units";
  const join = usesReservation ? `JOIN ${t.reservations} r ON r.account_id = a.id AND r.id = ?` : "";
  const joinArgs = usesReservation ? [reservationId!] : [];
  statements.push(db.prepare(`INSERT INTO ${t.ledger}
    (id, operation_id, account_id, reservation_id, kind,
     available_before, held_before, consumed_before, credited_before, adjusted_before,
     available_after, held_after, consumed_after, credited_after, adjusted_after, created_at)
    SELECT ?, ?, a.id, ?, ?, a.available, a.held, a.consumed, a.credited, a.adjusted,
      ${keys.map((key, i) => `a.${key} + (${deltas[i]})`).join(", ")}, ?
    FROM ${t.accounts} a ${join} WHERE a.id = ? AND ${active}`)
    .bind(`${claim}:${index}`, id, reservationId, action.kind, now, ...joinArgs, a.id, id, claim));
  // Read the exact after-snapshot just written, rather than repeating arithmetic.
  statements.push(db.prepare(`UPDATE ${t.accounts} SET
    (${keys.join(", ")}) = (SELECT available_after, held_after, consumed_after, credited_after, adjusted_after FROM ${t.ledger} WHERE id = ?)
    WHERE id = ? AND ${active}`).bind(`${claim}:${index}`, a.id, id, claim));
  if (usesReservation) {
    const state = { capture: "captured", release: "released", refund: "refunded" }[action.kind as "capture" | "release" | "refund"];
    statements.push(db.prepare(`UPDATE ${t.reservations} SET state = ?, updated_at = ? WHERE id = ? AND ${active}`)
      .bind(state, now, reservationId, id, claim));
  }
}
