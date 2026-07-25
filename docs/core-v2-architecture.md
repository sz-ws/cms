# Core v2 Architecture — Provider Layer + Two-Tier Extensions

Status: approved direction (2026-07-07). This document is the implementation spec.
Implementers: follow this exactly; where a detail is unspecified, match existing
codebase conventions (see `src/ext/`, `src/lib/`).

## 0. Goals

1. **Strong core, thin extensions.** Most extensions should be *declarative*
   (pure JSON manifests, installable at runtime from the admin UI, no rebuild).
   Only extensions that need custom code (React components, third-party SDKs,
   custom handlers) are *code extensions* (compile-time, CLI + rebuild).
2. **Provider/capability layer.** Core defines capability interfaces
   (`upload`, `content`, …). Default implementations live in core; code
   extensions can register alternative providers. Declarative extensions
   *consume* capabilities without knowing which provider backs them.
3. **GitHub as registry.** A plain GitHub repo serves as the default extension
   store (index + manifests + source files), fetched over raw.githubusercontent.

## 1. Versioning

- New file `src/ext/version.ts`:
  ```ts
  export const CORE_API_VERSION = "1.0.0";
  ```
- Extension manifests (both tiers) declare `coreApi: string` — a semver range
  (e.g. `"^1.0.0"`). Checked at enable/install time; incompatible → refuse with
  a clear error surfaced in `/admin/extensions`.
- Use a tiny hand-rolled semver-range checker (support `^x.y.z`, `~x.y.z`,
  exact, `>=x.y.z` only — no full semver lib; keep it <60 lines, tested).
- Breaking changes to `ApiCtx`, hook signatures, or provider interfaces →
  major bump. New hooks/capabilities/field types → minor bump.

## 2. Provider / capability layer

### 2.1 CoreServices

Extension API handlers currently receive `ctx: ApiCtx = { user }`. Extend to:

```ts
interface ApiCtx {
  user: SessionUser;
  services: CoreServices;      // NEW
}

interface CoreServices {
  db: ReturnType<typeof db>;          // drizzle instance (unscoped for now; scoping is v2.1)
  storage: ScopedStorage;             // putFile/deleteFile/listFiles pre-bound to scope=extId
  settings: ScopedSettings;           // get/set limited to `ext.<extId>.*` keys
  hooks: HookBus;                     // existing bus
  providers: ProviderRegistry;
}
```

`ScopedStorage` wraps `src/lib/storage.ts` with `scope` pre-bound.
`ScopedSettings.get(key)` reads `ext.<extId>.<key>`; `.set()` same. Attempts to
read/write outside the prefix throw.

### 2.2 ProviderRegistry

```ts
type Capability = "upload" | "content" | "doc-extraction" | (string & {});

interface ProviderRegistry {
  register(capability: Capability, id: string, impl: unknown): void;
  get<T>(capability: Capability): T;        // active provider (throws if none)
  list(capability: Capability): { id: string }[];
}
```

- Active provider selection: setting `core.provider.<capability>` holds the
  provider id; fallback = the provider registered with id `"core"`.
- Registration happens during extension loading. Code extension manifests gain:
  ```ts
  provides?: Array<{
    capability: Capability;
    id: string;                                  // provider id, e.g. "better-upload"
    create: (services: CoreServices) => unknown; // factory
  }>;
  ```
- Core registers its own defaults before extensions load.

### 2.3 Capability interfaces (v1)

```ts
interface UploadProvider {
  put(scope: string, filename: string, body: Blob | ReadableStream, contentType: string): Promise<StoredFile>;
  delete(key: string): Promise<void>;
  url(key: string): string;                      // default: `/api/files/${key}`
}
// Default impl "core": wraps src/lib/storage.ts.

interface ContentProvider {
  ensureType(def: ContentTypeDef): Promise<void>;
  create(type: string, data: Record<string, unknown>): Promise<ContentEntry>;
  get(type: string, id: string): Promise<ContentEntry | null>;
  getBySlug(type: string, slug: string): Promise<ContentEntry | null>;
  update(type: string, id: string, data: Record<string, unknown>): Promise<ContentEntry>;
  delete(type: string, id: string): Promise<void>;
  query(type: string, q: {
    filter?: Record<string, unknown>;            // equality only in v1
    sort?: { field: string; dir: "asc" | "desc" };
    page?: number; perPage?: number;             // perPage cap 100
  }): Promise<{ items: ContentEntry[]; total: number }>;
}

interface ContentEntry {
  id: string;                                    // nanoid
  type: string;
  slug: string | null;
  status: "draft" | "published";
  data: Record<string, unknown>;                 // validated against field defs
  createdAt: number; updatedAt: number;
}
```

`DocumentExtractionProvider` is deferred to the extend-ai extension phase; the
registry accepts arbitrary capability strings, so no core change needed then.

### 2.4 Default ContentProvider storage (JSON document model — no runtime DDL)

Declarative extensions install at runtime, so the default content store must
not require DDL. Single set of core tables (added via a normal drizzle-kit
core migration):

```sql
contents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,              -- "<extId>.<typeName>", e.g. "gallery.item"
  slug TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  data TEXT NOT NULL,              -- JSON
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX contents_type_slug ON contents(type, slug) WHERE slug IS NOT NULL;
CREATE INDEX contents_type_updated ON contents(type, updated_at);
```

Filtering/sorting on data fields uses SQLite `json_extract(data, '$.field')`.
Field defs marked `indexed: true` may later get a side index table — NOT in v1.
Schema evolution = manifest update only; unknown keys in stored `data` are
preserved and ignored. Document this behavior.

### 2.5 Unified callback ingress (inbound webhooks)

The provider methods cover **outbound** calls (`charge`, `submit`, `put`).
External services also call **back** — payment results, extraction-complete,
OAuth redirects. Rather than each extension inventing its own route + signature
check, there is ONE ingress:

```
POST /api/callback/<capability>/<providerId>
  e.g. /api/callback/payment/stripe
       /api/callback/extraction/extend-ai
```

Flow:
1. Public endpoint (no session — the caller is an external service).
2. Look up the provider by `(capability, providerId)` in the ProviderRegistry.
3. `provider.verifyCallback(rawBody, headers)` — **centralized** signature/HMAC
   verification; the signing secret comes from encrypted settings (`secret:true`).
4. On success `provider.handleCallback(rawBody, headers)` — update D1, fire a
   hook (e.g. `payment:succeeded`, `extraction:completed`) so other extensions
   can react.
5. Return 200; 4xx on bad signature, never leaking why.

Capability interfaces that receive callbacks add two optional methods:

```ts
verifyCallback(rawBody: string, headers: Headers): boolean | Promise<boolean>;
handleCallback(rawBody: string, headers: Headers): Promise<void>;
```

This is the **inbound counterpart** to the provider's outbound methods —
payment, doc-extraction, and OAuth all plug in identically, giving external
services one stable, documented URL shape to register against. Security: raw
body preserved for the signature check, https only, timing-safe compare, and a
replay window where the provider supports it.

## 3. Two-tier extension model

### 3.1 Tier 2 — code extensions (existing system)

Unchanged mechanics (compile-time registry, `extensions/` dir), plus:
- manifest gains `coreApi` (required) and `provides` (optional);
- `defineExtension()` validates the manifest with zod at load time
  (id pattern, semver fields, route shapes). Today it's trust-based — fix that.
- Update `extensions/posts` to declare `coreApi: "^1.0.0"`.

### 3.2 Tier 1 — declarative extensions (NEW)

A declarative extension is a JSON manifest, validated by zod, stored in D1,
interpreted by core at request time. No code ships.

Core table (core drizzle migration):

```sql
declarative_extensions (
  id TEXT PRIMARY KEY,             -- same id rules as code extensions
  manifest TEXT NOT NULL,          -- full validated JSON
  version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT,                     -- registry URL it came from
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```

Manifest schema v1 (zod source of truth in `src/ext/dx/manifest.ts`):

```jsonc
{
  "kind": "declarative",
  "id": "gallery",
  "name": "Gallery",
  "version": "1.0.0",
  "coreApi": "^1.0.0",
  "description": "…",
  "contentTypes": [{
    "name": "item",                       // full type key becomes "gallery.item"
    "label": "Gallery item",
    "slugField": "title",                 // auto-slug source, optional
    "fields": [
      { "key": "title",  "type": "text", "required": true, "label": "Title" },
      { "key": "image",  "type": "media" },
      { "key": "body",   "type": "richtext" },
      { "key": "shotAt", "type": "date" },
      { "key": "tag",    "type": "select", "options": ["street", "studio"] }
    ]
  }],
  "settings": [ /* same SettingField shape as code extensions */ ],
  "adminPages": [
    { "slug": "", "title": "Gallery", "view": "collection", "contentType": "item" }
  ],
  "publicRoutes": [
    { "pattern": "/gallery",        "view": "list",   "contentType": "item" },
    { "pattern": "/gallery/:slug",  "view": "detail", "contentType": "item" }
  ],
  "on": {                                  // declarative hook bindings, v1: webhook only
    "content:created": [{ "action": "webhook", "url": "https://…", "secretSetting": "webhookSecret" }]
  }
}
```

Field types v1: `text`, `richtext`, `number`, `boolean`, `date`, `media`,
`select` (with `options`), `slug`, `json`. Each maps to: a zod validator for
entry data, a form control in the generic FormView, and a cell renderer in
CollectionView.

Route patterns: plain segment strings with `:param` placeholders only. Compiled
by the existing O(n) matcher approach — **no regex** (ReDoS rule from 03 §).

### 3.3 Interpreter

`src/ext/dx/interpret.ts`: `interpretManifest(row): Extension` — converts a
stored declarative manifest into the same `Extension` shape the loader already
consumes:
- `adminPages` → generic server components (`CollectionView`, `FormView`)
  parameterized by contentType + fields;
- `publicRoutes` → `ListView` / `DetailView` generic components;
- `apiRoutes` → auto-generated CRUD endpoints
  (`GET/POST /api/ext/<id>/<type>`, `GET/PUT/DELETE /api/ext/<id>/<type>/:id`)
  backed by `services.providers.get<ContentProvider>("content")`;
  auth is `requireAuth()` with no role arg (see the dispatch route), so this
  CRUD — including publishing/unpublishing via `status` — is intentionally
  available to any authenticated role (editor+), not admin-only;

- `on` bindings → hook handlers that POST a signed JSON payload
  (HMAC-SHA256 with the referenced secret setting; include timestamp; 5s fetch
  timeout via AbortSignal; failures logged, never thrown).

Loader change (`src/ext/loader.ts`): runtime list = code registry ∪
interpreted declarative rows (per-request `cache()` as today). ID collisions
between tiers → declarative one is skipped with a logged error.

New hooks: `content:created`, `content:updated`, `content:deleted`
(action hooks, payload `{ type, id, data }`).

Generic views live in `src/ext/dx/views/` as server components (client
sub-components where needed for forms). Follow the admin's existing UI
conventions; keep files <400 lines each.

### 3.4 Install flow (declarative only)

- Setting `core.registrySources`: JSON array of base URLs; default
  `["https://raw.githubusercontent.com/sz-ws/registry/main"]`.
- `GET /api/registry/index` (admin auth): fetches `<base>/registry.json` from
  each source, merges, returns entries.
- `POST /api/registry/install` (admin auth, CSRF-checked): body `{ id, source }`.
  Fetches `<base>/extensions/<id>/manifest.json`, zod-validates, checks
  `coreApi` against `CORE_API_VERSION`, upserts `declarative_extensions`,
  fires `ext:enabled`.
- Only fetch from configured sources (SSRF guard: source must be an https URL
  from the configured list — never accept arbitrary URLs from the request).
- Uninstall: delete row + its settings (`ext.<id>.%`) + optionally its content
  (`contents` rows with type prefix `<id>.`) — ask via a `purgeContent` flag.
- Admin UI: `/admin/extensions` gains a **Browse** tab listing registry
  entries; declarative entries get Install/Update buttons; code entries show
  the CLI command to copy (`npx @sz-ws/cms add <id>`), disabled install.

### 3.5 Collection / list layout (declarable)

Listing views are not locked to a table. Both the admin `collection` page and
the public `list` route accept an optional `layout`:

```jsonc
"adminPages":   [{ "slug": "", "title": "Gallery", "view": "collection",
                   "contentType": "item", "layout": "grid" }],
"publicRoutes": [{ "pattern": "/gallery", "view": "list",
                   "contentType": "item", "layout": "grid" }]
```

- `layout`: `"table" | "grid"`, default `"table"`. `"grid"` renders entries as
  responsive cards (multiple per row) instead of one-per-row.
- Grid card anatomy is **inferred** from the content type's field defs, no extra
  config required:
  - **cover** = first `media`/`image` field (omitted → no image, text card),
  - **title** = the `slugField` source, else first `text` field,
  - **badge** = `status`; optional **meta** = first `select` or `date` field.
- Optional explicit override (v1.1, not required): `"card": { "image":
  "&lt;fieldKey&gt;", "title": "&lt;fieldKey&gt;", "subtitle": "&lt;fieldKey&gt;" }`.
- Grid follows Paper &amp; Ink: white cards, layered shadow-ring, concentric radii,
  image outline `rgba(0,0,0,0.1)`, hover lift, responsive (1→2→3→4 cols),
  designed empty state. Table mode is the just-built CollectionView; grid is a
  sibling renderer chosen by `layout`, sharing pagination/filter/sort/bulk.
- Adding `layout` is a CORE_API minor bump; absent `layout` = unchanged table
  behavior (back-compat).

### 3.6 Progressive extensions (declarative baseline + optional code enhancement)

Extensions are a **spectrum**, not a binary declarative-vs-code choice:

| Kind | At install (runtime) | After a code rebuild + deploy |
|---|---|---|
| **Pure declarative** | Works immediately; generic views | — (no code layer) |
| **Progressive** ⭐ | Works immediately; generic baseline | Same extension's marked surfaces upgrade to a richer custom UI + extra features declarative can't express |
| **Pure code** | Does not run (needs code-only capabilities) | Required to function at all |

The **progressive** middle is the key model. A single extension carries **two
coexisting layers**:

- **Baseline (declarative):** the manifest (content types + generic views).
  Runtime-installable, live the moment it's downloaded. Always present — the
  safety net.
- **Enhancement (code, optional):** custom components / handlers / extra
  features bundled with the extension. Because Workers can't runtime-load code,
  this layer only lights up after a **rebuild + deploy**. Before the build the
  user gets the generic baseline; after, the *same extension, same data* renders
  its custom surfaces and extra features.

**Override resolution.** The manifest may mark specific *surfaces* as
override-able — e.g. a content type's admin edit view, a public route's view, a
dashboard block, an extra API route. When the interpreter renders a surface for
an extension it consults a **code-override registry** keyed by
`(extId, surfaceId)`:

```
render(extId, surface):
  override = codeOverrideRegistry.get(extId, surface)   // present only if built+deployed
  return override ?? genericDeclarativeView(extId, surface)   // baseline is the fallback
```

This is the provider/capability philosophy (§2) pushed down to **per-extension,
per-surface** granularity. The declarative row stays installed and owns the
data + baseline; the code layer only overrides *presentation/behavior* of marked
surfaces.

**Surface-id scheme (v1 — implemented).** Helpers in `src/ext/dx/surfaces.ts`.
A surfaceId is the string `"<kind>:<contentType>:<view>"` where:
- `kind` ∈ `{ admin, public }`;
- `contentType` = the full type key `"<extId>.<name>"` (e.g. `gallery.item`);
- `view` ∈ `{ collection, form }` for `admin`, `{ list, detail }` for `public`.

v1 covers exactly the 4 view surfaces:

| surfaceId | Generic baseline (src/ext/dx/views) |
|---|---|
| `admin:<type>:collection` | `CollectionView` |
| `admin:<type>:form`       | `FormViewPage`   |
| `public:<type>:list`      | `ListView`       |
| `public:<type>:detail`    | `DetailView`     |

`buildSurfaceId`/`parseSurfaceId` + the `surfaceIds.{adminCollection,adminForm,
publicList,publicDetail}(contentType)` convenience builders own the scheme.
Parsing is pure string split (no regex; `contentType`'s internal `.` never
collides with the `:` outer separator). Dashboard-block and extra-API-route
overrides are **follow-ups**, not built in v1.

**Override registry API (v1 — implemented).** `src/ext/overrides.ts` exports a
module-level singleton `overrideRegistry` (mirrors `ProviderRegistry`, §2.2):
- `register<K>(extId, surfaceId, view, component)` — `view` (the surfaceId's
  `collection|form|list|detail`) binds the component's props at compile time to
  that surface's exported view props (`CollectionViewProps` / `FormViewPageProps`
  / `ListViewProps` / `DetailViewProps`, re-exported as `*SurfaceProps`).
  Duplicate `(extId, surfaceId)` from distinct call sites → throws.
- `get(extId, surfaceId): Component | null` — the resolution primitive.
- `has(extId, surfaceId): boolean` — lets a code layer make its own module-load
  self-registration idempotent (dev HMR re-evaluates the code module while the
  singleton's state persists; the guard keeps `register()` strict for genuine
  duplicates).
- `list(extId): string[]` — registered surfaceIds (debug/intent).

Code layers register at **module load**, pulled into the bundle via the existing
`extensions/registry.ts` import chain — so a rebuild + deploy is exactly what
"lights up" an override, matching the table above.

**Resolution in the interpreter (implemented).** `src/ext/dx/interpret.tsx` wraps
each of the 4 surfaces in a `resolveSurface(extId, surfaceId, GenericView)` that
returns `overrideRegistry.get(...) ?? GenericView`. The override component
receives the **same props** the generic view receives for that surface (props
contract). Zero behavior change when no override is registered.

**Manifest hint decision (v1).** Resolution is purely "is an override
registered?" — it is **not** gated on any manifest flag. This keeps it permissive
(a registered override wins; §3.6) and lets a code layer override without first
editing the manifest. An optional documentation-only `overridableSurfaces?:
string[]` hint may be added later; it would express intent, not gate resolution.

**Safety / back-compat.** An extension that declares an override it hasn't built
yet still works (generic fallback). Disabling or removing the code layer reverts
to baseline with no data loss. "Rebuild for a better experience" is therefore
never a destructive, one-way migration — it's an additive enhancement over a
baseline that always stands on its own. Verified end-to-end with the DEMO code
layer `extensions/gallery-enhance/` (overrides only `public:gallery.item:detail`
with a custom banner + hero + card-grid): with it registered the custom detail
renders; toggling the registration off reverts to the generic `DetailView` over
the same data; the gallery's other surfaces and every other extension (blog,
posts) are untouched.

### 3.7 Capability requirements (manifest feature-gating)

`coreApi` (§1) is a coarse, all-or-nothing version gate. Two finer,
**independent** axes let a manifest declare what it actually needs from the
running core, so install can refuse with a clear reason instead of the
extension breaking silently at runtime:

- **Axis (a) — core feature table.** Flat `manifest.capabilities: string[]`
  (roadmap #17). Each entry names a platform feature the extension needs
  (`"media"`, `"blocks"`, `"og-image"`, …). `src/ext/features.ts` holds the
  static list of features this core build actually ships (`CORE_FEATURES`);
  `missingCapabilities()` diffs the manifest's declared list against it.
  Checked at install time in `src/app/api/registry/install/route.ts`: any
  name not in `CORE_FEATURES` → install refused with
  `{ error: "missing_capabilities", missing: [...] }` (409). This catches a
  manifest written against a newer core, or a fork that never shipped a given
  feature — install-time failure instead of a silent runtime break.

- **Axis (b) — service requirements.** `manifest.requires: { capability,
  optional?, reason? }[]` (added 2026-07-10, commit `78eac1b`). Deliberately a
  separate axis from (a): capabilities asks "does this core build *know
  about* this feature"; `requires` asks "is there a **provider** registered
  for this capability right now" — the provider may be built into core
  (`upload`, `content`) or come from another installed code extension's
  `provides` (e.g. `email:send`, `cron:tick`). Judged by
  `src/ext/service-requirements.ts`: `availableServices()` reads the live
  `ProviderRegistry` capability list; `unmetRequiredServices()` filters
  `requires` down to the non-optional entries with no registered provider.
  - Non-optional entry, no provider → install refused with
    `{ error: "missing_services", missing: [...] }` (409), same fail-fast
    philosophy as (a): better to say "install the provider first" at install
    time than fail unpredictably later.
  - `optional: true` entry, no provider → install still allowed; the Browse
    UI (`RegistryBrowser.tsx`) renders the requirement as a suggestion chip
    (green = provided, red = required-and-missing, amber = optional-and-missing,
    `reason` shown as the chip tooltip).

Both axes are checked independently at install time in the same route, in the
order (a) then (b); either can 409 the install on its own.

#### Not implemented: nested `requires` + per-field `fallback` (future)

An earlier draft of this section proposed a third, more ambitious mechanism —
**graceful tiering**: a manifest part (e.g. a single field) declares a nested
`requires: { capabilities?: string[]; fieldTypes?: string[] }` *plus* a
`fallback` shape, so an unmet requirement would degrade that one part instead
of failing the whole install. Example sketch (never implemented):

```json
{ "key": "layout", "type": "blocks", "blocks": [ ... ],
  "requires": { "fieldTypes": ["blocks"] },
  "fallback": { "key": "layout", "type": "json" } }
```

The idea — the §3.6 progressive philosophy applied to the version/capability
axis, where richer capabilities light up per-part and a "minimum resource
version" (every optional part stripped to its fallback) always runs — is kept
here as a design note for a possible future iteration. What shipped instead
was the simpler two-axis, all-or-nothing-per-manifest model described above:
axis (a) and (b) both gate the *entire install*, not individual manifest
parts, and neither has a per-field `fallback` concept today.

## 4. Registry repo format (`suko-registry`)

Lives at repo root `registry/` during development; later extracted to its own
GitHub repo.

```
registry/
  registry.json               # index
  schema/manifest.schema.json # JSON Schema mirroring the zod schema
  extensions/
    gallery/manifest.json     # declarative example
    posts/                    # code example (source distribution)
      manifest.json           # metadata + "kind": "code"
      files/…                 # full source tree to copy into extensions/<id>/
  README.md                   # format docs + how to run your own registry
```

`registry.json` entry:

```json
{
  "id": "gallery",
  "kind": "declarative",
  "name": "Gallery",
  "version": "1.0.0",
  "coreApi": "^1.0.0",
  "description": "…",
  "author": "kuosuko"
}
```

## 5. Security invariants (carry-forward + new)

- All mutation routes: origin check (existing `src/lib/security.ts`).
- Declarative manifests: zod-validated at install AND at interpret time
  (defense against hand-edited DB rows).
- No regex anywhere in route matching; segment matcher only.
- Webhook actions: outbound only, https only, HMAC-signed, timeout-bounded.
- Secrets in settings: existing AES-GCM encryption applies (`secret: true`).
- Registry fetches: https, configured sources only, 1 MB response cap,
  JSON parse in try/catch, `redirect: "manual"` (a followed redirect could land
  the final request on a host outside the exact-match allowlist).
- Rate limiting (D1 `login_attempts` counter, generalized in `lib/rate-limit.ts`
  via `hitRateLimit(id, { namespace, limit, windowMs })`): login (existing),
  registry install, media upload/delete (by `user.id`), and the public
  callback ingress (by IP + capability/providerId) are all bounded.

## 6. Execution plan

| Phase | Scope | Files touched | Assigned |
|---|---|---|---|
| A | §1 version + §2 provider layer + §3.1 manifest v2 + zod validation + core migrations (contents, declarative_extensions) | `src/ext/*`, `src/lib/*`, `extensions/posts`, `migrations/` | Opus |
| B | §4 registry scaffold (`registry/` dir, docs, examples, JSON Schema) | `registry/` only | Sonnet |
| C | §2.4 default ContentProvider + §3.2–3.3 declarative engine (manifest zod, interpreter, generic views, CRUD routes, hooks) | `src/ext/dx/*`, loader | Opus |
| D | §3.4 install flow + Browse tab UI | `src/app/api/registry/*`, `/admin/extensions` | Sonnet |
| E | Review pass (typescript-reviewer + security-reviewer) over A–D | — | Sonnet agents |

Order: A ∥ B → C → D → E. Keep `tsc --noEmit` and `eslint` green at each phase.
