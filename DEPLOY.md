# Deploying to your own Cloudflare account

Run these from the repository root. Assumes the project already runs locally
(`pnpm dev` works) and you have a Cloudflare account.

The CLI completes the flow below, including first-admin setup. It shows a plan
and asks before changing anything:

```bash
pnpm run deploy --dry-run         # the plan; changes nothing
pnpm run deploy                   # same as node scripts/cms.mjs deploy
```

This uses your own Cloudflare account. The CLI is built from `cli/` on first use; it is not an npm release yet. See [`cms deploy`](cli/README.md#cms-deploy) for the order of steps, CI credentials and interrupted-run recovery. The following sections document the individual operations for reference.

## 1. Log in

```bash
pnpm exec wrangler login
```

## 2. Create the resources

One D1 database, **two** R2 buckets and one lifecycle rule. `DB` and
`NEXT_TAG_CACHE_D1` are two bindings, not two databases: the CLI points both at
the same one, because a Free plan account only gets ten D1 databases and the tag
cache holds nothing but `tag → revalidatedAt`. No KV namespace and no queue.

```bash
pnpm exec wrangler d1 create cms-db          # note the database_id
pnpm exec wrangler r2 bucket create cms-storage
pnpm exec wrangler r2 bucket create cms-next-cache
pnpm exec wrangler r2 bucket lifecycle add cms-next-cache expire-page-cache incremental-cache/ --expire-days 30
```

| Resource | Binding | What it holds |
|---|---|---|
| `cms-db` | `DB` | Everything: users, sessions, settings, content, extensions, jobs |
| `cms-db` | `NEXT_TAG_CACHE_D1` | The `revalidations` table: when the stored public pages were last invalidated, so every isolate agrees on what's stale |
| `cms-storage` | `STORAGE` | Uploaded media |
| `cms-next-cache` | `NEXT_INC_CACHE_R2_BUCKET` | Stored public pages (HTML and RSC payloads), keyed by build id |

The lifecycle rule deletes stored pages 30 days after they were written. Each
deploy starts a new key prefix and never reads the previous build's pages again,
so without the rule they stay in the bucket. A page still in use that reaches 30
days is rendered again on its next request. See
[Public pages are stored whole](#public-pages-are-stored-whole).

Want the tag cache in its own database — a multi-tenant account, or a hard
boundary between your schema and OpenNext's? Create a second `cms-<name>-tag-cache`
database by hand (`wrangler d1 create`) and put its name and id in the second
entry; `cms deploy` keeps a site set up that way.

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

`cms deploy` generates and sets the missing ones right after the Worker exists,
and uses `SETUP_TOKEN` itself to create the first admin; it never rotates an
existing one. `cms secrets` does the same check on its own and prints a newly
created `SETUP_TOKEN` once.

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

## Public pages are stored whole

Public pages (everything the catch-all `src/app/(public)/[[...slug]]` serves: the
home page, plugin public routes, a site layer's own pages and 404s, declarative list /
detail / form views; see `src/ext/META.md`, "A site supplies its own public pages") and
`/login` are rendered on their first request, stored in `NEXT_INC_CACHE_R2_BUCKET`
and then answered by OpenNext's cache interception without running the Next
server: one R2 read and one D1 query per request. `open-next.config.ts` sets this
up (`r2IncrementalCache`, `d1NextTagCache`, `enableCacheInterception`). Admin,
`/api`, `/setup`, robots, sitemap and feed are rendered on every request, as
before.

- **Nothing is rendered at build.** The build has no database, so the first
  request for each page after a deploy renders it.
- **A change refreshes every page.** A write to anything a plugin marked as
  visitor-facing (published content, settings, plugin install / enable /
  disable, declared tables and files; see "Public pages" in
  [`src/ext/META.md`](./src/ext/META.md)) invalidates all stored pages at once;
  each page is rendered again on its next visit. Draft saves do not.
- **If a page still shows something old** (a write made straight to the
  database, a plugin that forgot to say so), Settings → Site pages → "Remake all
  pages" invalidates them by hand.
- **Drafts:** editors open a draft from its edit screen ("Preview draft",
  `/api/preview?path=…`). That sets Next's draft-mode cookie: those requests skip
  the stored page and are never stored. The cookie's value is the same for every
  editor until the next deploy, so the middleware checks on each request that
  carries it that the browser still holds an editor session; otherwise it drops
  the cookie and the visitor gets the stored page. Signing out ends preview too.
- **Per-visitor parts** (who is signed in, the cart, a member's price) are
  fetched by the browser after the page shows. The `signed_in=1` cookie, set and
  cleared with the session and readable by scripts, tells the page whether
  asking is worth it.

Check it on a deployed site. A page answered from storage carries
`x-opennext-cache: HIT`; a page the Next server rendered carries
`x-nextjs-cache: MISS` instead:

```bash
curl -s -o /dev/null -D - https://<your-site>/ | grep -i -E 'x-(opennext|nextjs)-cache'   # first: x-nextjs-cache: MISS
curl -s -o /dev/null -D - https://<your-site>/ | grep -i -E 'x-(opennext|nextjs)-cache'   # then:  x-opennext-cache: HIT
```

Do the same for a detail page and `/login`. After you save a published entry,
the next request is a `MISS` with the new text, then `HIT` again.

## Upgrading a 1.x site to 2.0

The database needs no migration for 2.0, and both cache bindings already exist
in a 1.x `wrangler.jsonc`. What changes is configuration, one bucket rule and
the plugins.

2.0 loads only plugins whose `coreApi` range includes 2.0.0, and a `^1.x` range
does not. The plugins move first, while the site still runs 1.x, so that nothing
is missing at any point:

1. **Check each plugin** you use against the 2.0.0 entry in
   [`src/ext/version.ts`](./src/ext/version.ts) ("Moving a plugin from 1.x to
   2.0" in [`src/ext/META.md`](./src/ext/META.md) lists what to look for). The
   store shows each registry plugin's range; compiled-in plugins under
   `extensions/` declare it in `index.ts`. Most declarative manifests and many
   code plugins need no code change.
2. **Publish a version that runs on both.** A plugin that needs no change gets a
   new version whose range starts at its current minimum and has no upper
   bound, e.g. `">=1.17.0"` where it said `"^1.17.0"`. Both cores accept it; a
   two-sided range such as `">=1.17.0 <3.0.0"` is refused by both (the range
   check takes `x.y.z`, `^`, `~` and `>=` only). A plugin that needs 2.0-only
   code declares `"^2.0.0"` instead; its 1.x version stays installable for 1.x
   sites from the registry's `versions`.
3. **Update the plugins on the site while it runs 1.x**: install each new
   version from the store. Compiled-in plugins under `extensions/` change their
   range in `index.ts`; that ships with the core in step 8. A plugin whose new
   version declares `"^2.0.0"` cannot be installed on 1.x: it is unavailable
   from step 8 until you install that version, so plan a short gap for it.
4. **Merge 2.0** into your copy of the code.
5. **`wrangler.jsonc`:**
   - If `main` points at `worker/eager-entry.ts` (the optional eager startup
     entry of 1.85.0), set it back to `custom-worker.ts`: that file no longer
     exists and the build fails otherwise.
   - Remove the `CMS_KV` entry from `kv_namespaces` (and the array, if it was
     the only entry). 2.0 reads no KV.
   - Remove the `CMS_CSP` variable if you set one. Public pages send a fixed
     policy now (below).
   - Keep `NEXT_INC_CACHE_R2_BUCKET` and `NEXT_TAG_CACHE_D1`. If you removed
     either, put it back from the template.
6. **Lifecycle rule:** `cms deploy` adds it to the page-cache bucket (next to
   the bucket's other rules) and leaves everything else as it is; `cms status`
   and `cms doctor` report a leftover `<worker>-kv` namespace. By hand, the
   `wrangler r2 bucket lifecycle add` command from step 2 above.
7. **Your own pages.** The root layout no longer sets `force-dynamic`. A page you
   added under `src/app` outside the public catch-all that reads the database,
   cookies or headers needs its own `export const dynamic = "force-dynamic"`, or
   the build tries to render it without a database. To have such a page stored
   too, follow the catch-all's segment config (`dynamic = "error"`,
   `revalidate = false`, `generateStaticParams` returning `[]`) and move
   per-visitor parts to the browser.
8. **Deploy.** `opennextjs-cloudflare deploy` creates the `revalidations` table
   if it is missing.
9. **Check** with the `x-opennext-cache` commands above, then open
   `/admin/extensions` and confirm nothing is listed as unavailable.
10. **Delete the KV namespace** once you will not roll back to 1.x (1.x still
    reads it when bound):

    ```bash
    pnpm exec wrangler kv namespace list                         # find cms-<slug>-kv
    pnpm exec wrangler kv namespace delete --namespace-id <id>
    ```

### A plugin was missed

A plugin whose range does not include 2.0.0 stays enabled in the database but is
not loaded: `/admin/extensions` lists it as unavailable ("Requires core API
^1.17.0; this core provides 2.0.0"), its pages answer 404 and its API routes,
hooks, jobs and slot fills are absent. Installing or enabling it again is refused
with `409 incompatible_core_api`. Its tables, settings and content are kept.

To recover, either install a version whose range includes 2.0.0 as soon as the
author publishes one (the plugin is loaded again with its data), or roll
the Worker back to the last 1.x version (`wrangler rollback`) while you wait.
Rolling back needs the `CMS_KV` binding the 1.x version was deployed with, so do
not delete the namespace (step 10) before every plugin is back.

## Content-Security-Policy on public pages

Public pages are stored whole and served to every visitor, so their policy is a
fixed header sent from `next.config.ts`. The enforced `Content-Security-Policy`
covers script execution only: `script-src 'self' 'unsafe-inline' https:`, plus
`object-src 'none'`, `base-uri 'self'` and `frame-ancestors 'none'`. Everything
else (images, fonts, connections, form targets) stays in
`Content-Security-Policy-Report-Only` and is reported to `/api/csp-report`.
Admin, login and `/api` keep the Report-Only policy only.

Cloudflare zone features that inject scripts into HTML (Rocket Loader, Zaraz, Web
Analytics) are allowed by this policy when they load from `https:` hosts.

There is no per-request nonce: a stored page is the same for every visitor.
Inline scripts run under `'unsafe-inline'`, and the hosts a plugin's approved
scripts load from are no longer enforced by the header. The
`CMS_CSP` variable from 1.x is gone.

## Notes

- The project pins `pnpm@9.4.0` and requires Node **22.12+** (see `.node-version`);
  `wrangler` stays on a 4.x release.
- `next` and `@opennextjs/cloudflare` move **together**. Each OpenNext release
  declares the exact `next` range it was built against (via its `@opennextjs/aws`
  peer), and the range is narrow: `1.20.2` is the last release that accepts
  `next@16.2.x`; `1.20.3+` requires `next@>=16.3.3`, and `1.20.16` (used here
  with `next@16.4.6`) requires `next@>=16.4.5` and `wrangler@^4.148.0`. `pnpm install` prints an
  "unmet peer" line when the pair drifts — treat that as a build blocker, not a
  warning, and bump both or neither.
- `pnpm exec wrangler deploy --dry-run` gives you a config and bundle preflight before the real deploy.
- `cms deploy --dry-run` is a different thing: it reads what exists on your account through `cf` and prints the plan (`--json` returns it as `plan[]`). It sends no write and installs nothing; on a fresh clone it warns that wrangler's sign-in is checked after the real run installs dependencies.
- `migrations/` are applied to `cms-db` only. The tag cache binding points at the same database by default, and it declares no `migrations_dir` — its one table comes from OpenNext.
- After `opennextjs-cloudflare build`, run `pnpm exec wrangler deploy --dry-run` and check **Total Upload**, the uncompressed Worker bundle size. Since [September 4, 2026](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/), both Free and Paid plans allow **64 MiB uncompressed**; the former compressed-size limits and this project's 8 MB compressed gate no longer apply. The gzip figure is informational. Continue checking startup time (1 second) and runtime memory (128 MB); larger bundles do not increase those limits.
- Optional split server: `worker/split-entry.ts` is the same Worker as `custom-worker.ts` (both build their `fetch` and `scheduled` with `worker/create-worker.ts`), but the Next server is uploaded as its own module and every webpack chunk and route file as a further CommonJS module, each compiled the first time a request needs it. Requests answered by middleware or by the stored-page cache never load the server. The default entry stays `custom-worker.ts` and needs nothing extra. A site opts in by setting `main` in `wrangler.jsonc` to `worker/split-entry.ts`, adding `new_module_registry` to `compatibility_flags`, and adding `base_dir: ".open-next/split"`, `find_additional_modules: true` and the two `rules` listed in `worker/README.md`. `pnpm preview` and `cms deploy` run `scripts/split-server-chunks.mjs` after `opennextjs-cloudflare build` (a site that builds elsewhere, such as Workers Builds, runs it between build and deploy); it does nothing unless `main` is the split entry, and it stops the deploy when the build output does not have the shape it expects. `pnpm worker:smoke` (`scripts/smoke-worker-boot.mjs`) boots the built Worker with `wrangler dev --local` on a throwaway local D1 and checks `/`, `/admin`, `/robots.txt`, `/login`, a plugin page (`/shop/cart`, with the compiled-in shop enabled), two API routes and `/__scheduled`, so each check loads a different set of modules; CI runs both. Re-check the split on every OpenNext or Next upgrade. See `worker/README.md`.
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
