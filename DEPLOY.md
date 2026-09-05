# Deploying to your own Cloudflare account

Run these from the repository root. Assumes the project already runs locally
(`pnpm dev` works) and you have a Cloudflare account.

The CLI can now complete the flow below, including first-admin setup:

```bash
pnpm cli:build
node cli/dist/cli.js deploy --site-slug my-site
```

This uses your own Cloudflare account. The new CLI flow is currently a local development change, not an npm release. See [CLI deployment options](cli/README.md#one-command-deployment) for custom domains, CI credentials, and interrupted-run recovery. The following sections document the individual operations for reference.

## 1. Log in

```bash
pnpm exec wrangler login
```

## 2. Create the resources

One D1 database and **two** R2 buckets. `DB` and `NEXT_TAG_CACHE_D1` are two
bindings, not two databases: the CLI points both at the same one, because a Free
plan account only gets ten D1 databases and the tag cache holds nothing but
`tag → revalidatedAt`.

```bash
pnpm exec wrangler d1 create cms-db          # note the database_id
pnpm exec wrangler r2 bucket create cms-storage
pnpm exec wrangler r2 bucket create cms-next-cache
```

| Resource | Binding | What it holds |
|---|---|---|
| `cms-db` | `DB` | Everything: users, sessions, settings, content, extensions, jobs |
| `cms-db` | `NEXT_TAG_CACHE_D1` | On-demand `revalidateTag` timestamps, so every isolate agrees on what's stale |
| `cms-storage` | `STORAGE` | Uploaded media |
| `cms-next-cache` | `NEXT_INC_CACHE_R2_BUCKET` | Next.js ISR / data cache payloads |

Want the tag cache in its own database — a multi-tenant account, or a hard
boundary between your schema and OpenNext's? `cms setup --separate-tag-cache`
creates a second `cms-tag-cache` database instead; by hand that is one more
`wrangler d1 create cms-tag-cache`, and its id goes in the second placeholder.

## 3. Wire the IDs

Open `wrangler.jsonc` and replace **both** `00000000-0000-0000-0000-000000000000`
placeholders — with the *same* `database_id` from step 2, unless you deliberately
created a separate tag-cache database. Set the second entry's `database_name` to
match whichever database its id belongs to.

You do not need to create the `revalidations` table yourself.
`opennextjs-cloudflare deploy` runs its populate-cache step first, which issues
`CREATE TABLE IF NOT EXISTS revalidations (…)` itself. Its table name collides
with nothing in `src/lib/schema.ts`, which is what makes sharing one database
safe. That schema belongs to OpenNext (it gained `stale` / `expire` columns in
v1.19), so don't hand-copy a copy of it into this repo — it would drift.

## 4. Set the three production secrets

All three are **generate once, never rotate**. Do **not** reuse the development
values from `.dev.vars`.

### `SECRETS_KEY`

Every `secret: true` setting — registry tokens, the Resend API key, OIDC client
secrets, payment gateway keys — is AES-GCM encrypted with this.

```bash
openssl rand -base64 32
pnpm exec wrangler secret put SECRETS_KEY   # paste the value
```

> The encrypted envelope carries no key id and there is no gradual migration
> path, so rotating `SECRETS_KEY` later turns every stored secret into garbage.

### `AUTH_PEPPER`

HMAC-SHA256 applied to a password *before* it enters PBKDF2. workerd caps
PBKDF2 at 100,000 iterations per call, so the pepper is what makes an offline
attack against a leaked database impossible to even begin: the attacker would
first have to steal a Worker secret, which never appears in D1.

```bash
openssl rand -base64 32
pnpm exec wrangler secret put AUTH_PEPPER   # paste the value
```

> **Set this before you open `/setup`.** Each stored hash records whether it was
> peppered, and verification follows that flag — so adding the pepper later does
> not lock anyone out, but every password created before it stays unpeppered
> until its owner resets it.
>
> Removing the pepper afterwards *does* lock everyone out: those hashes can no
> longer be computed. There is no recovery path.

### `SETUP_TOKEN`

The bootstrap credential for `/setup`. Without it, whoever finds the URL first
becomes the administrator — there is a window between deploying and you opening
`/setup`, and `workers.dev` subdomains are enumerable. Same-origin checks stop
nothing here; an attacker sets their own headers.

```bash
openssl rand -base64 32
pnpm exec wrangler secret put SETUP_TOKEN   # paste the value
```

> This one is deliberately **fail-closed**: if it is not set, `/setup` returns
> 503 and no admin can be created at all. It is also the only one of the three
> you need to see — you type it into the `/setup` form. Once the first admin
> exists the endpoint returns 403 forever, so the token stops mattering.

`sz-ws-cms setup` generates and sets all three for you, and prints `SETUP_TOKEN`
(only that one — the other two never need to be seen by a human). It cannot do so on the very
first run — the Worker does not exist yet, so there is nothing to attach a
secret to. Deploy once, then re-run `setup`; it skips everything already done.

## 5. Migrate and deploy

```bash
pnpm db:migrate:remote   # applies migrations/ to cms-db only
pnpm run deploy
```

## 6. First run

Open the production URL and go to `/setup` to create the first admin account.
The form asks for `SETUP_TOKEN` from step 4. Production D1 starts empty and
shares nothing with your local database.

Then, in **Settings**, set `core.siteUrl` to your public origin. Several things
need an absolute URL and cannot infer one reliably: OIDC `redirect_uri`, SEO
canonical / sitemap / feed URLs, and payment gateway return URLs.

Finally, enable an extension under `/admin/extensions`, create an entry, and
confirm the public route renders it.

## Optional: image transformations

Uploaded images are served from `/api/files/<key>`, and that route can resize
and re-encode on the fly — `?w=640` gives you a 640px-wide WebP, and every CMS
render path emits a `srcset` over a fixed width ladder (320 / 640 / 960 / 1280 /
1920). This is what stops a 4 MB phone photo from being shipped to every
visitor.

The resizing itself runs through the `IMAGES` binding already declared in
`wrangler.jsonc`, which needs **Cloudflare Images enabled on the account**
(Dashboard → Images). Nothing else to configure — the binding is there either
way.

**If you do not enable it, nothing breaks.** When the binding is missing or the
transform fails, the route serves the original bytes with the same status,
content type, and security headers as before. You can tell the two apart from
the response header:

```bash
curl -sI "https://<your-worker>/api/files/core/2026/07/<id>.jpg?w=640" | grep -i x-image-transform
# x-image-transform: applied      → resized + re-encoded
# x-image-transform: unavailable  → transform failed, original served
# x-image-transform: none         → no variant asked for, or source not resizable
```

`/cdn-cgi/image/...` URL transformations are deliberately **not** used: those
are a zone-level feature and require the site to run on a Cloudflare zone with
transformations turned on, which a plain `*.workers.dev` deployment does not
have.

Intrinsic pixel dimensions are sniffed from the file header at upload time and
stored in the R2 object's `customMetadata` (`w` / `h`), next to the alt text.
Files uploaded before this existed simply have no dimensions recorded; they keep
serving normally, just without `width`/`height` attributes in the markup.

## Notes

- The project pins `pnpm@9.4.0` and requires Node **22.12+** (see `.node-version`);
  `wrangler` stays on a 4.x release.
- `next` and `@opennextjs/cloudflare` move **together**. Each OpenNext release
  declares the exact `next` range it was built against (via its `@opennextjs/aws`
  peer), and the range is narrow: `1.20.2` is the last release that accepts
  `next@16.2.x`; `1.20.3+` requires `next@>=16.3.3`. `pnpm install` prints an
  "unmet peer" line when the pair drifts — treat that as a build blocker, not a
  warning, and bump both or neither.
- `pnpm exec wrangler deploy --dry-run` gives you a config and bundle preflight before the real deploy.
- `node cli/dist/cli.js deploy --dry-run` is a different thing: it reports the deployment plan and reads what already exists on your account. It runs the project's own Wrangler, so it needs `pnpm install` to have finished; on a fresh clone it stops with exit 7 and tells you. `cms deploy` without `--dry-run` installs first, so it works on a fresh clone.
- `migrations/` are applied to `cms-db` only. The tag cache binding points at the same database by default, and it declares no `migrations_dir` — its one table comes from OpenNext.
- After `opennextjs-cloudflare build`, run `pnpm exec wrangler deploy --dry-run` and check **Total Upload**, the uncompressed Worker bundle size. Since [September 4, 2026](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/), both Free and Paid plans allow **64 MiB uncompressed**; the former compressed-size limits and this project's 8 MB compressed gate no longer apply. The gzip figure is informational. Continue checking startup time (1 second) and runtime memory (128 MB); larger bundles do not increase those limits.
- Schema changes are hand-written SQL in `migrations/`; `db:generate` is disabled on
  purpose. Scaffold the next migration with `pnpm db:new <slug>`, mirror the DDL in
  `src/lib/schema.ts` (same names, same columns), and verify with
  `pnpm test:run test/migration-parity.test.ts` — it applies every migration from
  scratch on a real D1 (workerd) and diffs the result against `schema.ts`
  table-by-table, column-by-column, index-by-index (partial-index predicates
  included).
- Migrations are append-only: once a file ships it is already applied on every
  existing deployment's D1, so editing it changes nothing there and silently
  forks new sites from old ones. `pnpm db:checksums` records each file's sha256
  in `migrations/meta/_checksums.json`; the same test fails if a shipped file
  changes. Need a different schema? Write the next migration.
