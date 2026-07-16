-- Login providers (declarative OIDC third-party login): identity linkage +
-- one-time OAuth state store. See docs/spec-login-providers.md §2.
--
-- Hand-written (NOT drizzle-kit generated), mirroring the 0006/0007/0008
-- precedent. The drizzle journal (migrations/meta/_journal.json) already stops
-- at 0004 — 0005..0008 were all added out-of-journal — so `drizzle-kit
-- generate` would next emit a colliding "0005_*". `wrangler d1 migrations
-- apply` picks up every *.sql by filename order and tracks applied ones in D1's
-- own d1_migrations table (it does NOT consult drizzle's journal), so this file
-- alone is enough for `pnpm db:migrate:local`. Both tables ARE modelled in
-- src/lib/schema.ts (userIdentities / oauthStates) so drizzle's query builder
-- sees them; the meta snapshots are intentionally left untouched to stay
-- consistent with 0005..0008.
--
-- The users table is intentionally NOT altered (avoids SQLite table-rebuild FK
-- risk): the new "guest" role is a TS-level enum value on the existing text
-- `role` column (no DDL needed), and OAuth-only users carry the sentinel
-- password_hash "!oauth-only" (not a pbkdf2 string, so verifyPassword is
-- always false with no timing branch). Users with no provider email get a
-- synthesized placeholder "oauth-<provider>-<sub8hex>@placeholder.invalid"
-- (the .invalid TLD guarantees undeliverable; email stays NOT NULL UNIQUE).
--
-- Semantics:
--   user_identities — one row per linked third-party identity. UNIQUE on
--     (provider, provider_user_id) enforces "one identity => one user"; the
--     ON DELETE CASCADE cleans identities when a user is deleted.
--   oauth_states — one-time PKCE/nonce state, consumed by a conditional
--     `DELETE WHERE id=? AND expires_at>now` whose meta.changes===0 rejects
--     replay/expiry (same pattern as webauthn_challenges).
CREATE TABLE user_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  display TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE UNIQUE INDEX user_identities_provider_sub ON user_identities(provider, provider_user_id);
CREATE INDEX user_identities_user ON user_identities(user_id);

CREATE TABLE oauth_states (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
