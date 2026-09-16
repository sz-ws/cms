/** Only trusted, compile-time extension prefixes may select tables. */
export function ledgerTables(prefix: string) {
  if (!/^ext_[a-z][a-z0-9_]{1,32}$/.test(prefix)) throw new Error("invalid ledger table prefix");
  return {
    accounts: `${prefix}_accounts`,
    operations: `${prefix}_operations`,
    reservations: `${prefix}_reservations`,
    ledger: `${prefix}_ledger`,
  };
}

const safeCounter = (name: string) => `${name} INTEGER NOT NULL DEFAULT 0
  CHECK(typeof(${name}) = 'integer' AND ${name} BETWEEN 0 AND 9007199254740991)`;

/** Owned and applied by the consuming extension, never by core migrations. */
export function ledgerSchema(prefix: string, options: { adjustments?: boolean } = {}): string {
  const t = ledgerTables(prefix);
  return `
    CREATE TABLE IF NOT EXISTS ${t.accounts} (
      id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      unit TEXT NOT NULL,
      precision INTEGER NOT NULL CHECK(precision BETWEEN 0 AND 4),
      ${safeCounter("available")},
      ${safeCounter("held")},
      ${safeCounter("consumed")},
      ${safeCounter("credited")},
      created_at INTEGER NOT NULL,
      UNIQUE(owner_type, owner_id, unit),
      CHECK(available + held + consumed = credited)
    );
    ${transactionSchema(prefix)};
    CREATE TABLE IF NOT EXISTS ${t.reservations} (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES ${t.accounts}(id),
      units INTEGER NOT NULL CHECK(typeof(units) = 'integer' AND units BETWEEN 1 AND 9007199254740991),
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('held', 'captured', 'released', 'refunded')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ${t.reservations}_account ON ${t.reservations}(account_id, state);
    CREATE TABLE IF NOT EXISTS ${t.ledger} (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL REFERENCES ${t.operations}(id),
      account_id TEXT NOT NULL REFERENCES ${t.accounts}(id),
      reservation_id TEXT REFERENCES ${t.reservations}(id),
      kind TEXT NOT NULL CHECK(kind IN ('credit', 'reserve', 'capture', 'release', 'refund')),
      available_before INTEGER NOT NULL,
      held_before INTEGER NOT NULL,
      consumed_before INTEGER NOT NULL,
      credited_before INTEGER NOT NULL,
      available_after INTEGER NOT NULL,
      held_after INTEGER NOT NULL,
      consumed_after INTEGER NOT NULL,
      credited_after INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ${t.ledger}_account ON ${t.ledger}(account_id, created_at, id)
  ` + (options.adjustments === false ? "" : `;${ledgerAdjustmentSchema(prefix)}`);
}

/** Receipt table for non-ledger participants such as orders and outboxes. */
export function transactionSchema(prefix: string): string {
  const t = ledgerTables(prefix);
  return `CREATE TABLE IF NOT EXISTS ${t.operations} (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      claim TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      matches INTEGER NOT NULL DEFAULT 1 CONSTRAINT ledger_idempotency CHECK(matches = 1),
      valid INTEGER NOT NULL DEFAULT 1 CONSTRAINT ledger_precondition CHECK(valid = 1)
    )`;
}

/** Append-only upgrade. credited remains net funding in storage; public credited
 * subtracts adjusted to preserve gross top-ups. Existing before/after rows survive.
 */
export function ledgerAdjustmentSchema(prefix: string): string {
  const t = ledgerTables(prefix);
  return `
    ALTER TABLE ${t.accounts} ADD COLUMN adjusted INTEGER NOT NULL DEFAULT 0 CHECK(typeof(adjusted) = 'integer' AND adjusted BETWEEN -9007199254740991 AND 9007199254740991);
    CREATE TABLE ${t.ledger}_v2 (
      id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES ${t.operations}(id),
      account_id TEXT NOT NULL REFERENCES ${t.accounts}(id), reservation_id TEXT REFERENCES ${t.reservations}(id),
      kind TEXT NOT NULL CHECK(kind IN ('credit','reserve','capture','release','refund','adjust')),
      available_before INTEGER NOT NULL, held_before INTEGER NOT NULL, consumed_before INTEGER NOT NULL, credited_before INTEGER NOT NULL,
      available_after INTEGER NOT NULL, held_after INTEGER NOT NULL, consumed_after INTEGER NOT NULL, credited_after INTEGER NOT NULL,
      created_at INTEGER NOT NULL, adjusted_before INTEGER NOT NULL DEFAULT 0, adjusted_after INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO ${t.ledger}_v2 (id,operation_id,account_id,reservation_id,kind,available_before,held_before,consumed_before,credited_before,available_after,held_after,consumed_after,credited_after,created_at)
      SELECT id,operation_id,account_id,reservation_id,kind,available_before,held_before,consumed_before,credited_before,available_after,held_after,consumed_after,credited_after,created_at FROM ${t.ledger};
    DROP TABLE ${t.ledger};
    ALTER TABLE ${t.ledger}_v2 RENAME TO ${t.ledger};
    CREATE INDEX ${t.ledger}_account ON ${t.ledger}(account_id,created_at,id)
  `;
}
