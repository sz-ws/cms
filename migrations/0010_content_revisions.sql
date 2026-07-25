-- Content revision history: new table `content_revisions` (one immutable
-- snapshot per meaningful write on a `contents` row, plus the acting user).
--
-- Hand-written (NOT drizzle-kit generated), mirroring the 0006..0009 precedent.
-- The drizzle journal (migrations/meta/_journal.json) already stops at 0004 —
-- 0005..0009 were all added out-of-journal — so `drizzle-kit generate` would
-- next emit a colliding "0005_*" (and `pnpm db:generate` is disabled outright,
-- see package.json). `wrangler d1 migrations apply` picks up every *.sql by
-- filename order and tracks applied ones in D1's own d1_migrations table (it
-- does NOT consult drizzle's journal), so this file alone is enough for
-- `pnpm db:migrate:local`. The table IS modelled in src/lib/schema.ts
-- (contentRevisions) so drizzle's query builder sees it; the meta snapshots are
-- intentionally left untouched to stay consistent with 0005..0009.
--
-- **Unlike 0007, the index below IS also declared in src/lib/schema.ts** (same
-- name, same columns). 0007 left `ext_jobs_recurring` living only in raw SQL,
-- which made schema.ts an incomplete description of the database; that drift is
-- not repeated here.
--
-- `contents` is deliberately NOT altered — the whole feature is additive, so a
-- separate effort can still reshape `contents` without colliding with this one.
--
-- Design notes (see src/lib/revisions.ts for the runtime contract):
--
--   Storage shape — FULL SNAPSHOT, not a diff. Each row carries the complete
--   restorable state of the content row at that point in time (slug / status /
--   publish_at / data JSON). id, type and created_at of the content row itself
--   are immutable and therefore not snapshotted. Rationale: reconstructing a
--   version from a diff chain costs O(n) D1 round-trips and needs a canonical
--   diff/patch implementation that must stay bug-free forever, while a snapshot
--   restores in one read and cannot be corrupted by a bad intermediate link.
--   Content rows here are small JSON documents and D1 bills round-trips more
--   than bytes; the storage bound comes from retention (below), not from diffs.
--
--   Retention — bounded per content row, not globally and not by age. The
--   `core.revisions.keep` setting (default 20, 0 disables capture entirely)
--   caps how many revisions any single content row keeps; the oldest are pruned
--   on every capture. Age-based expiry alone would silently erase the history
--   of a page edited once a year, which is exactly the page a studio client is
--   most likely to wreck.
--
--   actor_id — the acting user (session user at write time). NULL for
--   anonymous public creates (public:true content types) and for any write with
--   no request session. ON DELETE SET NULL so deleting a user keeps the history
--   but drops the attribution; the UI renders nothing when the join misses,
--   rather than leaking a raw internal id (same rule as DetailView's `author`).
--
--   ON DELETE CASCADE on content_id — deleting a content row drops its
--   revisions. Undelete is explicitly out of scope (it would need id/slug
--   conflict resolution against live rows). The provider also deletes them
--   explicitly, so behaviour does not depend on D1 FK enforcement being on.
CREATE TABLE content_revisions (
  id TEXT PRIMARY KEY,                  -- nanoid()
  content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                   -- "<extId>.<typeName>"(含 extension 宣告的型別)
  slug TEXT,                            -- 快照當下的 slug(可為 NULL)
  status TEXT NOT NULL,                 -- 'draft' | 'published'
  publish_at INTEGER,                   -- 快照當下的排程發佈時戳(epoch ms;NULL = 未排程)
  data TEXT NOT NULL,                   -- 完整 JSON document 快照
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,                 -- 'create' | 'update' | 'restore'
  created_at INTEGER NOT NULL
);
-- 單一 content 的歷史列表(created_at DESC)與保留數修剪都走這個索引。
CREATE INDEX content_revisions_content ON content_revisions (content_id, created_at);
