-- Public-form submission semantics: new side table `content_submissions`
-- (inbox state + reply bookkeeping for content rows that are inbound MESSAGES
-- rather than content awaiting publication).
--
-- Hand-written (NOT drizzle-kit generated), mirroring the 0006..0010 precedent.
-- The drizzle journal (migrations/meta/_journal.json) stops at 0004; every file
-- from 0005 on was added out-of-journal, and `pnpm db:generate` is disabled
-- outright (see package.json). `wrangler d1 migrations apply` picks up every
-- *.sql by filename order and tracks applied ones in D1's own d1_migrations
-- table, so this file alone is enough for `pnpm db:migrate:local`.
--
-- BOTH the table and the index below are also declared in src/lib/schema.ts
-- (same names, same columns). 0007 left
-- `ext_jobs_recurring` living only in raw SQL, which turned schema.ts into an
-- incomplete description of the database; that drift is not repeated here.
--
-- `contents` is deliberately NOT altered — not one column added, not one index
-- touched. That is a hard requirement of this change, for two reasons:
--
--   1. Concurrency. Other in-flight work reshapes `contents` (content
--      localisation adds columns and rewrites the slug index). A side table
--      keeps the two efforts from racing on the same DDL.
--   2. Semantics. `contents.status` ('draft' | 'published') is load-bearing in
--      three places that must keep meaning EXACTLY what they mean today:
--        - src/lib/jobs.ts `publish-due` selects status='draft' AND
--          publish_at IS NOT NULL,
--        - the public Content API forces filter.status='published',
--        - the public list/detail views query published entries.
--      Widening that column's value space (e.g. storing 'unread' in it) would
--      require re-reasoning about all three, and would also collide with
--      ContentEntry.status being typed 'draft' | 'published' across the whole
--      provider contract (CoreContentProvider.rowToEntry coerces it). Keeping
--      status untouched means those three predicates are provably unaffected by
--      this change: a submission row keeps status='draft' and publish_at NULL,
--      so it is invisible to the public API by construction, and `publish-due`
--      additionally excludes anything that has a row in THIS table.
--
-- Design notes (runtime contract: src/lib/submissions.ts):
--
--   content_id is the PRIMARY KEY — exactly zero or one inbox record per
--   content row. ON DELETE CASCADE so the existing retention story keeps
--   working untouched: a declarative `schedule[]` deleteOlderThan job (and the
--   registry `contact` extension declares a 180-day one) deletes through
--   ContentProvider.delete, and the inbox record goes with it. No orphans, and
--   no second purge job to write or forget.
--
--   `type` is denormalised from contents.type. It is what makes the inbox list
--   and the per-state counts answerable without joining `contents` for every
--   count, and it is what the partial index below is keyed on. It is written
--   once at insert and never updated (a content row's type is immutable).
--
--   `state` is 'unread' | 'read' | 'archived'. Three states, no more: they are
--   the three answers an operator actually needs ("is this new?", "have I
--   looked at it?", "am I done with it?"). Anything finer is a CRM.
--
--   `replied_at` is NOT a fourth state. Replying and filing are orthogonal —
--   a message can be replied to and then archived, and collapsing that into a
--   linear state machine would destroy the very record ("did anyone answer this
--   person?") that the state machine was supposed to provide. NULL = no reply
--   recorded.
--
--   A missing row means 'unread'. That is what makes this migration safe on a
--   live site: submissions that already exist as draft content rows simply have
--   no record here, and the inbox reads them as unread without any data
--   backfill. New submissions get a row stamped at create time, which is also
--   what gives `publish-due` its explicit NOT EXISTS guard something to see.

CREATE TABLE IF NOT EXISTS content_submissions (
  content_id TEXT PRIMARY KEY REFERENCES contents(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'unread',
  replied_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- Inbox listing / counting is always "within one content type, filtered by
-- state". This index covers that; because the table only ever holds submission
-- rows, it stays small regardless of how much normal content the site has.
CREATE INDEX IF NOT EXISTS content_submissions_type_state
  ON content_submissions (type, state);
