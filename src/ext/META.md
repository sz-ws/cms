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
  - `semver.ts`: coreApi ↔ CORE_API_VERSION range comparison.
  - `version.ts`: CORE_API_VERSION constant.
  - `admin-menu.ts`: sidebar data model; `admin-access.ts` (1.50.0): custom-role rules —
    grantable pages, levels, `accessAs`, the roles matrix derived from the sidebar.
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
    widget on commerce-kit's `REVENUE`). Removed in 2.0.
  - `commerce-kit/metrics.ts` (1.62.0): `REVENUE` (`commerce.revenue`), the metric every plugin that
    takes money declares for its series on the dashboard.
  - `plugin-ref.ts`: plugin identity (`<publisher>/<name>`) and plugin-to-plugin requirement rules, pure (server + client).
  - `installed-plugins.ts`: what is installed (both kinds) with identity and requirements; used by the store index, install route, enable/disable and the extensions page.
  - `code-lifecycle.ts`: besides the code-plugin guards, the SQL guards that carry plugin requirements into the declarative enable/disable writes.
