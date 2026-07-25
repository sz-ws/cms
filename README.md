# sz.ws CMS

An extension-first CMS that runs entirely on Cloudflare Workers.

One Worker serves the admin, the public site, and the extension API. Content
lives in D1, files in R2. There is no origin server, no container, and no
separate frontend to deploy.

> **Status:** actively developed, pre-1.0. The core API is versioned
> (`CORE_API_VERSION`, currently **1.18.0**) and extensions declare the range
> they support, so upgrades are checked rather than hoped for. Expect the
> version number itself to be reset to `1.0.0` at the first stable release.

## Why another CMS

Most self-hosted CMSes make you choose between "configure it in a UI and hit a
wall" or "write code for everything". This one draws the line differently:

- **Declarative extensions** are a single JSON manifest — content types, admin
  pages, public routes, settings, webhooks, scheduled cleanup, dashboard cards,
  OIDC login buttons. They install at runtime from the admin UI. No rebuild, no
  deploy, no code.
- **Code extensions** are for the cases that genuinely need code: custom React
  components, third-party SDKs, cryptographic signing. They compile in.

The interesting part is that both tiers talk to the same **capability layer**.
Core defines interfaces (`upload`, `content`, `email:send`, `ai:generate`,
`payment`); core ships default implementations; code extensions can register
alternatives. A declarative extension consumes a capability without knowing or
caring which provider backs it.

## What's in the box

| | |
|---|---|
| **Content** | JSON document model, no runtime DDL. Field types incl. relations, groups, repeaters, and named blocks for page building. Draft/published, scheduled publish. |
| **Admin** | Composable dashboard, per-extension pages, auto-generated settings forms, ⌘K palette backed by D1 FTS5 full-text search. |
| **Auth** | Session + password, passkey (WebAuthn), and declarative third-party OIDC login providers. Roles: admin / editor / guest. |
| **API** | Read-only public Content API with bearer tokens, per-type exposure allowlist, tagged edge caching. |
| **Extensions** | GitHub-repo-as-registry — an index plus manifests, fetched over `raw.githubusercontent.com`. No registry server to run. |
| **Jobs** | Periodic and one-shot extension jobs, declarative retention schedules. |
| **i18n** | Admin in English and 繁體中文; extension manifests can localize user-facing strings inline. |

## Quickstart

Requires Node 20+ and pnpm 9. You do **not** need a Cloudflare account to run
it locally.

```bash
pnpm install          # also writes .dev.vars and cloudflare-env.d.ts if absent
pnpm db:migrate:local
pnpm dev
```

Open `/setup` to create the first admin account.

`pnpm install` generates two gitignored files a fresh clone doesn't have: a
`.dev.vars` holding a freshly generated development `SECRETS_KEY` (every
`secret: true` setting is AES-GCM encrypted with it), and `cloudflare-env.d.ts`
from `wrangler types`. If you'd rather do it yourself, see
[`.dev.vars.example`](./.dev.vars.example) and run `pnpm cf-typegen`.

Schema changes are hand-written SQL in `migrations/` — `db:generate` is
deliberately disabled and will tell you why if you run it.

To deploy to your own Cloudflare account, see [DEPLOY.md](./DEPLOY.md) — it
walks through creating the D1 database and R2 buckets, setting the secrets
key, and running remote migrations.

## Installing extensions

Declarative extensions install from the admin UI: **Extensions → Browse →
Install**. Nothing else is needed.

Code extensions need to be compiled in, so they go through the CLI:

```bash
npx @sz.ws/cms add <id>
```

That fetches the extension source into `extensions/<id>/` and patches the
registry. Running migrations, enabling the extension, and deploying stay
manual and explicit — the CLI prints exactly what's left to do.

Point the CMS at your own registry (or a private one) under
**Settings → Registry sources**; the CLI takes `--source` and `--token`.

## Architecture

`docs/core-v2-architecture.md` is the source of truth. Each significant
directory also carries a `META.md` orienting you to what lives there — start
with [`src/META.md`](./src/META.md).

```
src/ext/          extension runtime: loader, capabilities, providers
src/ext/dx/       declarative engine: manifest schema, interpreter, generic views
src/lib/          core services: db, storage, auth, search, jobs, i18n
extensions/       compile-time code extensions
cli/              the `add` installer, published as @sz.ws/cms
migrations/       D1 migrations (Drizzle)
```

## Testing

```bash
pnpm test:run      # core suite, Cloudflare Workers pool
pnpm test:cli      # CLI suite, plain Node
pnpm lint
```

## Licence

Apache-2.0 — see [LICENSE](./LICENSE).

The core is complete and useful on its own. `src/licensing/` is an optional
open-core extension point: a commercial build can drop in a real verifier
there, and an open-source checkout automatically gets a community-mode stub at
build time. Nothing in this repository is crippled by its absence.

---

Built by [@kuosuko](https://okuso.uk) · part of [sz.ws](https://sz.ws)
