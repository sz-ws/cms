-- FTS5 full-text search over `contents` (admin search backend).
--
-- Hand-written (NOT drizzle-kit generated): drizzle-orm has no FTS5 virtual-table
-- support, so this table is intentionally absent from src/lib/schema.ts and the
-- drizzle meta snapshots/_journal.json. `wrangler d1 migrations apply` picks up
-- every *.sql in migrations/ by filename order and tracks applied ones in D1's
-- own d1_migrations table — it does not consult drizzle's journal — so this file
-- alone is enough for `pnpm db:migrate:local`.
--
-- Storage model: a "contentless-ish" external table whose rows are maintained at
-- the application layer (src/lib/search.ts) — NO SQLite triggers (D1 trigger
-- support is limited and the source `data` column is JSON, so indexing happens
-- in TypeScript in the content write path). content_id/type_key are UNINDEXED
-- (stored for row identity + join back to `contents`, not tokenised); title/body
-- carry the searchable text. unicode61 + remove_diacritics 2 gives accent-folded,
-- Unicode-aware tokenisation.
CREATE VIRTUAL TABLE content_fts USING fts5(
  content_id UNINDEXED,
  type_key UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
