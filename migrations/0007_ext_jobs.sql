-- Extension jobs surface: new table `ext_jobs` (periodic + one-off tasks
-- contributed by extensions via `Extension.jobs` / `services.jobs.schedule()`).
--
-- Hand-written (NOT drizzle-kit generated), mirroring the 0006 precedent. The
-- drizzle journal (migrations/meta/_journal.json) already stops at 0004 —
-- 0005 and 0006 were both added out-of-journal — so `drizzle-kit generate`
-- would next emit a colliding "0005_*". `wrangler d1 migrations apply` picks
-- up every *.sql by filename order and tracks applied ones in D1's own
-- d1_migrations table (it does NOT consult drizzle's journal), so this file
-- alone is enough for `pnpm db:migrate:local`. The table IS modelled in
-- src/lib/schema.ts (extJobs, columns only — the two indexes below are
-- native to this migration and intentionally not re-declared there) so
-- drizzle's query builder sees it; the meta snapshots are intentionally left
-- untouched to stay consistent with 0005/0006.
--
-- Semantics (docs/spec-extension-jobs.md): reconciled + claimed + executed by
-- the `ext-jobs` core job (src/lib/jobs.ts), which runs alongside `publish-due`
-- inside runDueJobs (lazy sweep / manual / cron:tick all drive it the same way).
CREATE TABLE ext_jobs (
  id text PRIMARY KEY,                      -- crypto.randomUUID()
  ext_id text NOT NULL,
  job_id text NOT NULL,
  kind text NOT NULL,                       -- 'once' | 'recurring'
  run_at integer NOT NULL,                  -- 下次到期 epoch ms
  payload text,                             -- JSON;僅 once 使用
  attempts integer NOT NULL DEFAULT 0,      -- 僅 once 使用
  status text NOT NULL DEFAULT 'pending',   -- 'pending' | 'dead'(僅 once 會 dead)
  last_run integer,                         -- 上次實際執行 epoch ms(觀測)
  last_error text,                          -- 上次失敗訊息(觀測;成功清 NULL)
  created_at integer NOT NULL
);
CREATE INDEX ext_jobs_due ON ext_jobs (status, run_at);
CREATE UNIQUE INDEX ext_jobs_recurring ON ext_jobs (ext_id, job_id) WHERE kind = 'recurring';
