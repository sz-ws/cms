import { prepareOperation } from "./operations";
import { ledgerTables } from "./schema";

export type TransactionValue = string | number | null;
type Predicate = { sql: string; args: readonly TransactionValue[] };
export type TransactionMutation =
  | { kind: "guard"; condition: Predicate }
  | { kind: "insert"; table: string; values: Record<string, TransactionValue> }
  | { kind: "update"; table: string; values: Record<string, TransactionValue>; where: Predicate };

/** Trusted server code only. SQL structure must never come from an HTTP input.
 * All values are bound; writes are automatically gated by the transaction claim.
 * A required update must have an explicit guard (zero updated rows is not failure).
 */
export function prepareTransaction(db: D1Database, prefix: string, mutations: readonly TransactionMutation[]) {
  ledgerTables(prefix);
  if (!mutations.length || mutations.length > 50) throw new Error("expected 1–50 mutations");
  function value(input: TransactionValue): TransactionValue {
    if (input === null || typeof input === "string" || (typeof input === "number" && Number.isSafeInteger(input))) return input;
    throw new Error("invalid transaction value");
  }
  function predicate(input: Predicate): Predicate {
    if (!input.sql || /;|--|\/\*|\*\//.test(input.sql)) throw new Error("invalid transaction predicate");
    return { sql: input.sql, args: input.args.map(value) };
  }
  const copied = mutations.map((mutation): TransactionMutation => {
    if (mutation.kind === "guard") return { kind: "guard", condition: predicate(mutation.condition) };
    if (mutation.kind !== "insert" && mutation.kind !== "update") throw new Error("invalid mutation");
    if (!mutation.table.startsWith(`${prefix}_`) || !/^[a-z][a-z0-9_]*$/.test(mutation.table) || mutation.table === ledgerTables(prefix).operations) throw new Error("invalid transaction table");
    const entries = Object.entries(mutation.values).sort(([a], [b]) => a.localeCompare(b));
    if (!entries.length || entries.length > 40 || entries.some(([key]) => !/^[a-z][a-z0-9_]*$/.test(key))) throw new Error("invalid transaction columns");
    const values = Object.fromEntries(entries.map(([key, input]) => [key, value(input)]));
    return mutation.kind === "insert" ? { kind: "insert", table: mutation.table, values } : { kind: "update", table: mutation.table, values, where: predicate(mutation.where) };
  });
  return prepareOperation(db, prefix, { kind: "transaction", mutations: copied });
}

export function appendTransaction(db: D1Database, statements: D1PreparedStatement[], prefix: string, mutations: readonly TransactionMutation[], id: string, claim: string) {
  const receipt = ledgerTables(prefix).operations;
  const active = `EXISTS (SELECT 1 FROM ${receipt} WHERE id = ? AND claim = ?)`;
  for (const mutation of mutations) {
    if (mutation.kind === "guard") {
      statements.push(db.prepare(`UPDATE ${receipt} SET valid = CASE WHEN (${mutation.condition.sql}) THEN 1 ELSE 0 END WHERE id = ? AND claim = ?`).bind(...mutation.condition.args, id, claim));
    } else {
      const entries = Object.entries(mutation.values);
      const args = entries.map(([, value]) => value);
      if (mutation.kind === "insert") {
        statements.push(db.prepare(`INSERT INTO ${mutation.table} (${entries.map(([key]) => key).join(", ")}) SELECT ${entries.map(() => "?").join(", ")} WHERE ${active}`).bind(...args, id, claim));
      } else {
        statements.push(db.prepare(`UPDATE ${mutation.table} SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE (${mutation.where.sql}) AND ${active}`).bind(...args, ...mutation.where.args, id, claim));
      }
    }
  }
}
