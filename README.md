# CMS

A starting point for building a website on Cloudflare Workers — not a product
you configure, and not a hosted service.

Clone it and you already have authentication, a content model, media storage,
scheduled publishing, full-text search, and a bilingual admin. What you add is
the shape of *your* site: a JSON manifest you install at runtime, no rebuild.

> **Status:** pre-1.0 and developed in the open. The core API is versioned and
> extensions declare the range they support, so upgrades are checked rather
> than hoped for — but that version number will be reset to `1.0.0` at the
> first stable release. Pin a commit if you need stability today.

## The short path

Requires Node **22.12+** and pnpm 9 (`rolldown`, which Vitest 4 builds on, declares `^20.19.0 || >=22.12.0`; Node 20 reached end-of-life in April 2026, so 22.12 is the floor here). `.node-version` pins it. You do **not** need a Cloudflare account to run
it locally.

```bash
pnpm install          # also fills in .dev.vars and cloudflare-env.d.ts
pnpm db:migrate:local
pnpm dev
```

Open `/setup` and create the first admin account. It asks for a setup token —
that is `SETUP_TOKEN` in the `.dev.vars` that `pnpm install` just generated.
(The endpoint is fail-closed on purpose: in production, "whoever finds the URL
first" must not be able to claim the admin account.)

Then **Extensions → Browse** and install one from the default registry to see
the shape of the thing.

What you install is a JSON manifest. This one is complete — it is all it takes
to add a content type with an admin section and two public pages:

```json
{
  "kind": "declarative",
  "id": "recipes",
  "name": "Recipes",
  "version": "1.0.0",
  "coreApi": "^1.0.0",
  "description": "A recipe collection.",
  "contentTypes": [
    {
      "name": "recipe",
      "label": "Recipe",
      "slugField": "title",
      "fields": [
        { "key": "title",   "type": "text",     "label": "Title", "required": true },
        { "key": "summary", "type": "text",     "label": "Summary" },
        { "key": "photo",   "type": "media",    "label": "Photo" },
        { "key": "body",    "type": "richtext", "label": "Method" }
      ]
    }
  ],
  "adminPages": [
    { "slug": "", "title": "Recipes", "view": "collection", "contentType": "recipe" }
  ],
  "publicRoutes": [
    { "pattern": "/recipes",       "view": "list",   "contentType": "recipe" },
    { "pattern": "/recipes/:slug", "view": "detail", "contentType": "recipe" }
  ]
}
```

That gives you an editor with a media picker, draft / published states and
scheduled publishing, plus `/recipes` and `/recipes/:slug` on the public site.
No rebuild, no deploy, no code.

### Authoring your own

Manifests are installed **from a registry**, not pasted into the admin. A
registry is just a git repo served over https — an index plus one folder per
extension — so to iterate on a manifest of your own you need it reachable at a
raw https URL, then added under **Settings → Registry sources**.

The quickest route is to fork the default registry, or create a repo with this
shape:

```
registry.json                     # index: id, kind, name, version, coreApi
extensions/recipes/manifest.json  # the manifest above
```

> **Known friction.** There is no local authoring loop yet: the install path
> requires an https source (an SSRF guard rejects anything not exactly matching
> a configured registry source), so today every manifest edit means a push.
> If you are only trying things out, editing an installed extension's row in
> D1 directly is faster.

Most of building a site with this is writing manifests like the one above.
When you need something a manifest can't express — a custom React component, a
third-party SDK, cryptographic signing — you drop to a **code extension**,
which compiles in. The two tiers talk to the same capability layer, so a
manifest can use uploads, email or AI without knowing what's behind them.

## What you don't have to build

| | |
|---|---|
| **Auth** | Password, passkey (WebAuthn), and third-party OIDC sign-in declared in a manifest. Roles: admin / editor / guest. |
| **Content** | JSON document model, no runtime DDL. Text, richtext, media, relations, and nested group / repeater / block fields for page building. Draft and scheduled publish. |
| **Admin** | Auto-generated editors and settings forms, composable dashboard, ⌘K search over your content (D1 FTS5). English and 繁體中文. |
| **Public site** | Generic list / detail / form views driven by your manifest, tagged edge caching, robots / sitemap / feed. |
| **API** | Read-only public content API with bearer tokens and a per-type exposure allowlist. |
| **Jobs** | Periodic and one-shot extension jobs, declarative retention schedules. |

## Deploying

See [DEPLOY.md](./DEPLOY.md). It's about ten steps against your own Cloudflare
account — two D1 databases, two R2 buckets, one secret.

## Installing extensions

Declarative extensions install from the admin UI: **Extensions → Browse →
Install**. Nothing else is needed.

Code extensions have to be compiled in, so they go through a CLI:

```bash
npx @sz.ws/cms add <id>
```

> **Not published yet.** The CLI lives in [`cli/`](./cli) and works, but the
> package is unpublished while naming settles. Until then, copy the extension
> source into `extensions/<id>/` and add a line to `extensions/registry.ts`
> yourself — that is all the CLI does, plus a compatibility check.

Point the CMS at your own registry — or a private one — under **Settings →
Registry sources**.

## Making it yours

- **Name and branding:** `package.json`, the `name` in `wrangler.jsonc`, and `core.siteTitle` / `core.brandLogo` in Settings.
- **Your own registry:** `core.registrySources` in Settings; the default points at a public one you almost certainly want to replace.
- **Design:** the admin follows a house style documented in `docs/admin-design-language.md`. Public views read CSS custom properties, so a manifest's `theme` block can tint them without touching core.
- **Your first extension:** copy the manifest above, or start from one in the registry.

## What ships as a demo

These exist to show what the system can do. Delete them from your own site:

- `extensions/gallery-enhance/` — a side-effect import in `extensions/registry.ts` demonstrating how a code extension overrides one view of a declarative one.
- `extensions/ai-smoke-test/` — a reference consumer of the `ai:generate` capability. Not in the default bundle; add it to `registry.ts` if you want to try that capability.
- `/admin/ui-sandbox` — a component gallery.
- Any seeded content in your local database.

## What this is not

- Not multi-tenant. One deployment, one site.
- Not a hosted service. You run it on your own Cloudflare account.
- No dark mode, on purpose.
- Scheduled work runs on a lazy sweep — precision is "within a minute of somebody opening the admin" unless you install the `cron` extension.
- `SECRETS_KEY` cannot be rotated. Decide where it lives before you deploy.

## Architecture

[`docs/core-v2-architecture.md`](./docs/core-v2-architecture.md) is the source
of truth. Each significant directory also carries a `META.md` — start with
[`src/META.md`](./src/META.md).

```
src/ext/          extension runtime: loader, capabilities, providers
src/ext/dx/       declarative engine: manifest schema, interpreter, generic views
src/lib/          core services: db, storage, auth, search, jobs, i18n
extensions/       compile-time code extensions
cli/              the extension installer
migrations/       D1 migrations (hand-written SQL; db:generate is disabled)
```

## Testing

```bash
pnpm test:run      # core suite, Cloudflare Workers pool
pnpm test:cli      # CLI suite, plain Node
pnpm lint
```

## Licence

Apache-2.0 — see [LICENSE](./LICENSE). `src/licensing/` is an optional
open-core extension point; an open-source checkout gets a community-mode stub
at build time and nothing is crippled by its absence.

---

Built by [@kuosuko](https://okuso.uk) · part of [sz.ws](https://sz.ws)
