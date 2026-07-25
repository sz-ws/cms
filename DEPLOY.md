# Deploying to your own Cloudflare account

Run these from the repository root. Assumes the project already runs locally
(`pnpm dev` works) and you have a Cloudflare account.

## 1. Log in

```bash
pnpm exec wrangler login
```

## 2. Create the resources

There are **two** D1 databases and **two** R2 buckets. It's easy to miss the
second of each — `wrangler.jsonc` ships with two `00000000-…` placeholders.

```bash
pnpm exec wrangler d1 create cms-db          # note the database_id
pnpm exec wrangler d1 create cms-tag-cache   # note this one too
pnpm exec wrangler r2 bucket create cms-storage
pnpm exec wrangler r2 bucket create cms-next-cache
```

| Resource | Binding | What it holds |
|---|---|---|
| `cms-db` | `DB` | Everything: users, sessions, settings, content, extensions, jobs |
| `cms-tag-cache` | `NEXT_TAG_CACHE_D1` | On-demand `revalidateTag` timestamps, so every isolate agrees on what's stale |
| `cms-storage` | `STORAGE` | Uploaded media |
| `cms-next-cache` | `NEXT_INC_CACHE_R2_BUCKET` | Next.js ISR / data cache payloads |

## 3. Wire the IDs

Open `wrangler.jsonc` and replace **both** `00000000-0000-0000-0000-000000000000`
placeholders with the two `database_id` values from step 2 — the first belongs
to `cms-db`, the second to `cms-tag-cache`.

You do not need to create the `revalidations` table inside `cms-tag-cache`.
`opennextjs-cloudflare deploy` runs its populate-cache step first, which issues
`CREATE TABLE IF NOT EXISTS revalidations (…)` itself. That schema belongs to
OpenNext (it gained `stale` / `expire` columns in v1.19), so don't hand-copy a
copy of it into this repo — it would drift.

## 4. Set the production encryption key

Every `secret: true` setting — registry tokens, the Resend API key, OIDC client
secrets, payment gateway keys — is AES-GCM encrypted with this. Do **not** reuse
the development value from `.dev.vars`.

```bash
openssl rand -base64 32
pnpm exec wrangler secret put SECRETS_KEY   # paste the value
```

> The encrypted envelope carries no key id and there is no gradual migration
> path, so rotating `SECRETS_KEY` later turns every stored secret into garbage.
> Decide now where this value lives.

## 5. Migrate and deploy

```bash
pnpm db:migrate:remote   # applies migrations/ to cms-db only
pnpm deploy
```

## 6. First run

Open the production URL and go to `/setup` to create the first admin account —
production D1 starts empty and shares nothing with your local database.

Then, in **Settings**, set `core.siteUrl` to your public origin. Several things
need an absolute URL and cannot infer one reliably: OIDC `redirect_uri`, SEO
canonical / sitemap / feed URLs, and payment gateway return URLs.

Finally, enable an extension under `/admin/extensions`, create an entry, and
confirm the public route renders it.

## Notes

- The project pins `pnpm@9.4.0`; `wrangler` stays on a 4.x release that runs on Node 20.
- `pnpm exec wrangler deploy --dry-run` gives you a config and bundle preflight before the real deploy.
- Watch the worker size reported by `opennextjs-cloudflare build` — it should stay under 8 MB compressed.
- Schema changes are hand-written SQL in `migrations/`; `db:generate` is disabled on purpose.
