import type { TransactionMutation } from "./transaction";
import { assertPrecision, parseUnits } from "./amount";
import { ledgerTables } from "./schema";
import type { LedgerAccount, LedgerOperation, LedgerOwner } from "./types";

export type LedgerAction =
  | { kind: "transaction"; mutations: readonly TransactionMutation[] }
  | { kind: "open"; account: LedgerAccount }
  | { kind: "credit"; account: LedgerAccount; units: number }
  | { kind: "adjust"; account: LedgerAccount; units: number }
  | { kind: "reserve"; account: LedgerAccount; units: number; reservationId: string; source: LedgerOwner }
  | { kind: "capture" | "release" | "refund"; account: LedgerAccount; reservationId: string };

interface PreparedOperation {
  db: D1Database;
  prefix: string;
  action: LedgerAction;
}

// No raw statement or mutable action escapes to consumers. Copy refs at prepare time.
const prepared = new WeakMap<LedgerOperation, PreparedOperation>();

export function checkedText(value: string, field: string, max = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

export function copyOwner(owner: LedgerOwner): LedgerOwner {
  return { type: checkedText(owner.type, "owner type", 64), id: checkedText(owner.id, "owner id") };
}

export function copyAccount(account: LedgerAccount): LedgerAccount {
  assertPrecision(account.precision);
  return {
    id: checkedText(account.id, "account id"),
    owner: copyOwner(account.owner),
    unit: checkedText(account.unit, "unit", 64),
    precision: account.precision,
  };
}

export function positiveUnits(amount: string, precision: number): number {
  const units = parseUnits(amount, precision);
  if (units === 0) throw new Error("amount must be positive");
  return units;
}

export function prepareOperation(db: D1Database, prefix: string, action: LedgerAction): LedgerOperation {
  ledgerTables(prefix);
  const token = Object.freeze({}) as LedgerOperation;
  prepared.set(token, { db, prefix, action });
  return token;
}

/** Internal: not exported from the public barrel. */
export function readOperation(token: LedgerOperation): PreparedOperation {
  const value = prepared.get(token);
  if (!value) throw new Error("unknown ledger operation");
  return value;
}
