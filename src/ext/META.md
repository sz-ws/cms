# ext META

- Extension runtime (core-v2 spec §2.1–§3.6).
- Two flavours:
  - **code extensions**: bundled at build, contribute React components + API handlers + migrations via `extensions/<id>/`.
  - **declarative extensions**: stored as manifests in D1 (`declarative_extensions`); interpreted by `dx/` on every page render.
- Subdirs:
  - `dx/`: declarative interpreter (manifest, runtime, fields, views, content-provider, dispatch).
  - `providers/`: provider registry + capability layer (core-v2 §2.2).
  - `loader.ts`: merges code + declarative into one `ExtRuntime`.
  - `overrides.ts`: progressive override registry (per-surface code replacement).
  - `services.ts`: per-request scoped service bundle.
  - `types.ts`: shared Extension / ApiRoute / PublicRoute / HookName contract.
  - `hooks.ts`: typed action/filter bus.
  - `slots.ts` (1.74.0): slots — the one way an upper layer changes a lower one. `defineValueSlot` /
    `defineSlot` declare a named place, a plugin's `fills` fill it (`fill(slot, …)`), and the request's
    `ExtRuntime.slots` resolves it. Order follows `Extension.layer`: plain plugins, then "agency", then
    "site"; a layer is on when compiled in, without being enabled. `account-entries.ts` is the slot for the entries of a signed-in person's account area (plus how to read them), `after-sign-in.ts` is the slot through which a plugin asks a member for one more step right after sign-in (read by `/api/auth/continue`; staff are never detoured), `admin-attention.ts` is the slot through which a plugin says which admin pages have something waiting (the dot in the sidebar; see its own entry below), `site-path.ts` checks a supplied address; `core-slots.ts` holds core's own slots
    (admin sidebar sections and items, admin status sets, and one slot per admin content list and edit
    page); UI slots are placed with `components/Slot.tsx` (server) and `components/SlotRegion.tsx`
    (client). `services.slots` is the same registry for jobs and API handlers; `slots.explain(slot)` says
    who filled what. Slots are for changing a lower layer; services (payment, stock, checkout fields)
    stay capabilities. `CMS_LAYER_FILLS=off` (Worker variable) skips the fills of both layers.
  - `admin-attention.ts` (1.77.0): the value slot `AdminAttention` (`admin.sidebar.attention`) — which admin
    pages have something waiting for the owner. A plugin appends `{ href, count() }` in its `fills`:
    `fill(AdminAttention, (sources) => [...sources, { href: "/admin/ext/my-plugin", count: () => countWaiting() }])`.
    `href` is the page as it appears in the sidebar; `count` answers how many are waiting now (a number or a
    promise of one) and runs every time the sidebar asks, so keep it to one cheap query. The sidebar asks
    `GET /api/admin/attention` (`askAdminAttention`) and draws a small static dot where the count is above
    zero: on the page's row, on a closed folder or a collapsed section that holds it, and on the icon's corner
    when the sidebar is docked. It never shows a number; the count is in the row's screen-reader text. Only
    pages the signed-in person can open are asked (`sessionCanOpen` in `admin-access.ts`, the decision the
    sidebar's menu uses; a role it does not know opens nothing). Sources run in parallel with 2 s each. One
    that answers with a non-number counts as zero. One that throws or hangs is logged and its page is listed
    as `unknown` in the answer: the sidebar keeps that page's dot as it was, so a busy database does not make
    a dot disappear. At most 50 sources, a count is capped at 9999, several sources for one page are added up. Right after the owner handles something, the page calls
    `refreshAdminAttention()` (`components/admin/attention.tsx`, a client module) and the dot follows at once;
    without it the sidebar asks again on the next page change, when the tab comes back, and every 120 s.
    Requires coreApi `^1.77.0`.
  - `semver.ts`: coreApi ↔ CORE_API_VERSION range comparison.
  - `version.ts`: CORE_API_VERSION constant.
  - `admin-menu.ts`: sidebar data model; `admin-access.ts` (1.50.0): custom-role rules —
    grantable pages, levels, `accessAs`, the roles matrix derived from the sidebar. `sessionCanOpen`
    (1.77.0) says which admin pages a signed-in person can open; the sidebar menu and
    `/api/admin/attention` both ask it.
  - `mcp-server.ts` (1.59.0): the MCP JSON-RPC handler for AI connections — the agent tool
    registry over `/api/mcp`; writes only on connections allowed to change things, audited as
    source "mcp" with the app's name.
  - `member-facets.ts` (1.60.0): `Extension.memberFacets` — what each person on the member list
    (`/admin/users`) is to a plugin. A facet (`id`, `label`, `read(userIds, ctx)`, optional
    `actions`) gets a table column and a CSV column (its `badge`), a 有 / 沒有 filter
    (`?<extId>.<facetId>=has|missing`, shared by the page and the export), and a section in the
    member sheet (`lines` as a label/value list, `actions` as links to admin pages, shown for
    people with a value, without one, or always). `ctx` is `{ services, locale, timeZone }`, with
    `services` scoped to the plugin (`services.db` is the database). `users-data.ts` reads every
    facet in parallel with all user ids; a facet that throws, times out (3 s) or returns something
    that is not an object is logged and left out, and invalid values or links are dropped one by
    one. Only people who can open the member list see facets. Requires coreApi `^1.60.0`.
  - `agent-tools-media.ts` (1.60.0): `core.media.list` (read) and `core.media.upload` (write,
    from a public URL or base64) — stores through `lib/media-upload.ts`, same as the admin uploader.
  - `agent-guide.ts` (1.60.0): the guide for AI — orientation plus recipes built from what is
    enabled, each extension's `agentGuide`, then the owner's `core.ai.notes`. Appended to the
    assistant's system prompt and sent as MCP `initialize` instructions.
  - `dashboard-widgets.ts` (1.62.0): the dashboard contract — `Extension.dashboardWidgets` (cards of
    kind number / timeseries / proportion / list with `load(ctx)`, optional `unit`, `metric`,
    `period`, `href`) and `Extension.metrics` (shared numbers `<namespace>.<name>` with a unit and
    `combine: sum | overlay`; a widget's metric must be declared by the same plugin, values are never
    negative), plus the zod rules defineExtension and the runtime share. Units and
    their formatting live in `lib/units.ts` (site currency: `core.currency`). Requires coreApi `^1.62.0`.
  - `dx/dashboard-widgets.ts` (1.62.0): the pipeline behind the dashboard's plugin section — collects
    metrics (the first declaration of a key in plugin order wins; a later plugin that declares it
    differently loses only its own widgets on it, logged), checks each widget, skips what the viewer can't
    open, reads the period from the URL, calls every `load` isolated (3 s) for this and — for summed
    period cards — the previous period, validates the data (`dx/dashboard-widget-data.ts`), merges
    widgets on the same metric into one card and orders cards by plugin, then declaration.
    Declarative `dashboardCards` join it (stat → number card; recent cards keep their renderer).
  - `dx/dashboard-stats.ts`, `dx/dashboard-revenue.ts`: adapters for the deprecated 1.52.0
    `dashboardStats` (→ number cards, `display` kept) and 1.61.0 `dashboardRevenue` (→ a timeseries
    widget on commerce-kit's `REVENUE`). Removed in a later major version.
  - `commerce-kit/metrics.ts` (1.62.0): `REVENUE` (`commerce.revenue`), the metric every plugin that
    takes money declares for its series on the dashboard.
  - `providers.ts` `ProviderRegistry.find(capability, guard?)` (1.63.0): the one provider of a capability
    that passes the guard, or null when none or several qualify (several are logged). Used where core
    needs "whoever provides X" instead of a fixed id (returns restock: `inventory` + `isRestockProvider`).
  - `commerce-kit/order-manager.ts` (1.63.0): the order-management contract on `commerce:orders`
    (provider id = orders table): `checkout`, `transition`, optional `storefront()` and
    `reportTransfer()`. Ownership is the orders row's `managed_by`; `resolveOrderOwner` routes
    transitions and reports, a disabled manager is 409 `order_managed` (customers get
    `customerOrderManagedResponse()`, without the plugin's name), a checkout with managed orders and no
    manager is 503 `checkout_paused`. Core's own orders are reported with the order's email (or by the
    signed-in owner or an admin). `legacy-ownership.ts` (old `<table>_managed` check),
    `legacy-storefront.ts` (`guestCheckout()` fallback) and `managed.ts` (`ManagedCommerceProvider`
    alias) are removed in a later major version.
  - `commerce-kit/customer-order.ts`: `resolveCustomerOrder` answers "is this caller the customer of this
    order" for public routes where customers act on their own orders. A managed order asks the manager's
    optional `customerOrder()` (member by session, guest by order number + email; it also says when the
    order shipped); core's own orders go by order number + the order's email. Not theirs and not found
    are the same answer. Email proofs are rate limited here, before anything is looked up
    (`startOrderEmailProof`, `ORDER_EMAIL_PROOF_LIMITS`): only wrong guesses count (the attempt is given
    back once the caller is proven), 10 per order number and client address and 60 per order number over
    all addresses in 15 minutes, so guessing with someone's order number cannot lock that customer out.
    A manager must not limit inside `customerOrder()` and shares the budget by calling
    `startOrderEmailProof` in its own lookup. First user: `commerce-kit/returns-customer.ts`, the public
    `returns/customer` route where a customer asks for a return within N days of shipment (an extension
    setting; 0 = off, and then the route answers everyone the same without looking anything up). The
    request is an ordinary `requested` return whose `created_by` starts with `customer`; the amount is
    never taken from the customer.
  - `commerce-kit/checkout-fields.ts` (1.63.0): plugin checkout fields on `commerce:checkout-fields`
    (`<providerId>.<key>`), `validateCheckoutFields` → order `meta` or 422 `field_invalid`;
    `checkout-prefill.ts` is the browser store (`checkout.prefill.v1`) other pages fill.
  - `payment-kit/report-spec.ts` (1.63.0): what a transfer report asks for (reference with label and
    digits, payer name, either, both) — `ManualPaymentProvider.reportSpec()`, default 帳號末五碼 / 5.
    `commerce-kit/transfer-legacy.ts` keeps the old `last5` body field until 2.0.
  - `commerce-kit/money.ts`: `formatMoney(amount, currency)` on `lib/units.ts`; client components read the
    site currency from `components/CurrencyProvider.tsx` (root layout), server tables render `MoneyText`.
  - `commerce-kit/shipping-engine.ts`: `regions` in the shipping config (≤ 60) with `DEFAULT_REGIONS`
    (Taiwan) and `shippingRegions(config)`; the shop's shipping page edits them (`editRegions`).
  - `plugin-ref.ts`: plugin identity (`<publisher>/<name>`) and plugin-to-plugin requirement rules, pure (server + client).
  - `installed-plugins.ts`: what is installed (both kinds) with identity and requirements; used by the store index, install route, enable/disable and the extensions page.
  - `code-lifecycle.ts`: besides the code-plugin guards, the SQL guards that carry plugin requirements into the declarative enable/disable writes.

## Public pages

A public page — a `PublicRoute`, the `publicHome` / `publicHeader` / `publicFooter` /
`publicWidgets` filters, a declarative list, detail or form view — is rendered once, stored
whole and sent to every visitor from the page cache without running the Next server
(`src/app/(public)/[[...slug]]/page.tsx`, `lib/public-cache.ts`). Decide before you write the
page whether it asks the server anything after it shows, in this order:

1. **Default: it asks nothing.** The HTML is the same for every visitor. When what it shows
   changes, the stored pages are refreshed — all of them, on their next visit. Three points:
   - **Mark what visitors see.** `visitorFacing` means only "visitors can see output that
     depends on this"; whoever owns a thing marks it (`lib/visitor-facing.ts`):

     | Thing | Where | Default |
     |---|---|---|
     | Content type | `contentTypes[].visitorFacing` | `true` |
     | Setting field | `settings[].visitorFacing` | `true`; keys you never declared: `false` |
     | Table | `visitorFacingTables: ["ext_acme_stock"]` (or `{ table: false }`) | `false`; commerce-kit's order and promo tables: `true` |
     | Your files (keys under your id) | `visitorFacingFiles: true` | `false` |
     | The plugin itself (install, enable, disable, remove, scripts) | `visitorFacing` | `true` |

     Things people edit in the admin default to `true` (mark `false` to opt out); things
     programs write default to `false` (mark `true` to opt in). Core marks its own settings and
     file areas the same way.
   - **Core refreshes on any write to a marked thing**: content saves, settings writes,
     ledger-kit and commerce-kit writes, file deletes and plugin lifecycle all go through one
     rule. Content counts only while an item is published before or after the write, so draft
     saves, anonymous form submissions and draft clean-up refresh nothing, and a public page
     must never show draft content.
   - **Anything else calls `services.publicContentChanged(reason)` after the write**: rows you
     write with `services.db` outside ledger-kit, a setting key you did not declare, external
     state.

   Most pages end here. These look per-visitor but are refreshes, not server calls: stock, a price that is the same
   for everyone, "new" or "sold out" badges, anything that changes when someone saves in the
   admin, a scheduled publish (the job writes and refreshes). A date window (a sale banner,
   the site notice): put the window in the HTML and let the browser decide.
2. **It asks only for what differs per visitor or must be current to the second:** who is
   signed in, a cart kept on the server, a price only this member gets, their orders,
   submitting a form, placing an order. These go in a client component.
3. **If it asks:**
   - A write is a server action (or your existing API route), run by the visitor's action — a
     click, a submit — never on page load.
   - A read on page load is at most one call per page view, and is skipped when the answer is
     already known in the browser (an empty cart in `localStorage`, a visitor who never signed in).
   - Use a server action when only your component needs the answer: one import, its own POST
     and same-origin checks. Use an API route (`apiRoutes`, `GET`, `Cache-Control: private,
     no-store`) when something else needs the same answer or you want a URL you can open.
   - Why "no call" is the default: each call is a Next server request. Measured on a test site,
     a stored page costs about 10 ms CPU; a call costs 0.2–0.4 s and 10–80 ms CPU when the
     Worker is warm, and 300–700 ms CPU on a cold Worker, which has to start the server first.
4. **What breaks:** reading `cookies()`, `headers()`, `connection()` or `searchParams` (or a
   `fetch` with `cache: "no-store"`) while the page renders. Public routes are
   `dynamic = "error"`, so Next refuses: `next dev` shows `Route /[[...slug]] with
   dynamic = "error" couldn't be rendered statically because it used cookies()`, production
   answers that URL with a 500 and stores nothing. Also: no `revalidate = <number>`, no
   `revalidateTag(tag, "max")`, no module-level memo with a time limit in code that renders a
   public page, and pagination in the path (`/blog/page/2`), not `?page=`.
5. **No nonce.** The per-request CSP nonce is gone in 2.0: nothing sets `x-nonce`, and a page
   that is the same for every visitor cannot carry one. Inline scripts run under
   `'unsafe-inline'`, external scripts load from any `https:` host (DEPLOY.md,
   "Content-Security-Policy on public pages").
6. **Drafts.** Visitors never see drafts. An editor opens one through `/api/preview?path=…`
   (the "Preview draft" link), which turns on Next's draft mode for that browser; those requests
   render on the server and are never stored. A public route with drafts of its own reads them
   only when `(await draftMode()).isEnabled` (`next/headers`; it is always off in the render that
   gets stored), as `dx/views/DetailView.tsx` does. Relation fields show only published items.
7. **Signed in?** The session cookie is HttpOnly. `signed_in=1` (`lib/signed-in-hint.ts`,
   `hasSignedInHint(document.cookie)`) is set and cleared with it and says only whether asking
   the server who this is can be worth a request.

Requires coreApi `^2.0.0`.

## Moving a plugin from 1.x to 2.0

A plugin whose `coreApi` range does not include 2.0.0 (every `^1.x` range) is not loaded on a 2.0
core: `/admin/extensions` lists it as unavailable ("Requires core API ^1.x; this core provides
2.0.0"), its public routes, API routes, hooks, jobs and slot fills are absent, and enabling or
installing it is refused. To move one:

1. **Public output reads no request.** In `PublicRoute` components and the `publicHome`,
   `publicHeader`, `publicFooter` and `publicWidgets` filters, remove `cookies()`, `headers()`,
   `connection()`, `searchParams`, `getSessionUser()` and decisions on the current time. Move what
   differs per visitor into a client component that asks after the page shows (points 2 and 3
   above). Pages under `next dev` show the error at once; check every public route there.
2. **Remove `x-nonce` reads** (`headers().get("x-nonce")`). Inline scripts and third-party
   widgets work without it.
3. **Mark or announce writes** (point 1 above). Declare `visitorFacingTables` for ledger-kit tables
   visitors see, `visitorFacingFiles` for files under your id that public pages show, set
   `visitorFacing: false` on content types and settings that never reach a public page, and call
   `services.publicContentChanged(reason)` after any other write that changes what visitors see.
   A missing announcement shows as a stale page until the next change or deploy.
4. **No time-based caching:** no `export const revalidate = <number>`, no
   `revalidateTag(tag, "max")`, no module-level memo with a time limit in public render code.
   `unstable_cache` reads from `ext/dx/content-cache.ts` (`cachedPublicQuery`,
   `cachedPublicGetBySlug`) are gone; read through the content provider directly.
5. **Choose the range.** Sites update their plugins while they still run 1.x and upgrade the core
   afterwards (DEPLOY.md, "Upgrading a 1.x site to 2.0"), so a plugin that runs on both majors
   publishes a version for both first:
   - **Unchanged by 2.0** (nothing in points 1–4 applies, which includes most declarative
     manifests): keep the minimum and drop the upper bound, `"^1.17.0"` → `">=1.17.0"`. Both cores
     accept it (`test/semver.test.ts`). Two-sided ranges (`">=1.17.0 <3.0.0"`) and `||` are not
     part of the range syntax (`semver.ts`, the manifest schemas): both cores refuse them. The
     open-ended range also admits a later major, so narrow it to `"^2.0.0"` in a later version once
     your sites are on 2.0.
   - **Needs 2.0-only code** (it calls `services.publicContentChanged`, declares `visitorFacing*`
     markers, or no longer works on 1.x after points 1–4): declare `"^2.0.0"`. Request reads moved
     to the browser (points 1–2) usually run on 1.x as well; then the first case applies. A registry that also serves 1.x sites keeps the
     previous version under `versions` in its `registry.json` (`lib/registry-versions.ts`), so 1.x
     cores keep installing that one; on a site the plugin is unavailable from the core upgrade until
     the new version is installed.

   Either way a plugin delivered through a registry needs a new version, or sites are not offered
   the update. Compiled-in plugins change the range in `index.ts`.
