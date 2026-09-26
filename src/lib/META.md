# lib META

- Framework glue that does not live inside any specific feature.
- `auth.ts`: session + cookie + role gating. 1.50.0: `getSessionAccess()` (the
  out-of-scope user + a custom role's access map), `isFullAdmin()`.
- `access-scope.ts`, `access-guards.ts` (pages), `access-api.ts` (APIs): the doors
  a custom role (角色與權限) passes through. Inside a door it runs as admin; the rules
  for which page / route needs which level live in `ext/admin-access.ts`.
  `withinAdminPage()` narrows a door to one page inside a handler or provider;
  `canEditCurrentPage()` and `adminPageLevels()` tell screens which write controls
  to draw.
- `admin-nav.ts`: the admin sidebar menu and sections (layout + roles matrix share it).
- `staff-roles.ts`: custom roles in D1 (`staff_roles`, `users.staff_role_id`).
- `cf.ts`: Cloudflare env accessors (`getEnv`, `getDB`, `getStorage`).
- `db.ts`: drizzle wrapper (uses `getDB()`).
- `security.ts`: origin check + timing-safe compare.
- `csp.ts`: every Content-Security-Policy string (zero deps: `next.config.ts` and the
  middleware both load it). Public pages enforce script-src with a per-request nonce;
  admin/API stay Report-Only.
- `script-hosts.ts`: how the CSP allowlist is computed from `declarative_extensions` rows
  (approved, enabled scripts whose hash still matches). Zero deps; shared by the
  middleware, the KV stamps copy and the cold read.
- `public-csp.ts`: the middleware's `cachedApprovedScriptHosts`, memoised per isolate
  behind a version stamp. A cold isolate takes the list from the KV copy, or reads the
  stamp and the list in one D1 batch.
- `stamps.ts`: the version stamps behind the settings, extension-runtime and CSP
  memos — the SQL, the exact string formats, and the optional Workers KV copy
  (`CMS_KV`) that public GET pages read instead of D1. The copy also carries the CSP
  allowlist (`hosts`), read in the same batch as the stamps. Loadable by the middleware
  and the Worker entry. Writes publish through `invalidateSettingsCache` /
  `invalidateExtRuntimeMemo`; a copy older than five minutes is ignored.
- `request-stamps.ts`: one round trip per request for the settings + runtime stamps
  (`getRequestStamps`, React-cached); KV only when the middleware marked the request
  as a public page (`x-cms-public-page`), D1 otherwise.
- `cold-snapshot.ts`: a cold isolate's first read — stamps, the whole settings table,
  enabled extension ids and every `declarative_extensions` row in one D1 batch. The
  settings memo and the extension loader use it only when its stamps equal the
  request's; invalidation drops it.
- `rate-limit.ts`: shared `hitRateLimit` (D1 KV-style table).
- `extra-fields.ts`: additional fields an admin adds per content type
  (`core.content.extraFields`; values in `data.extra`). Pure (zod only) so the settings
  manager and editors share it; `extra-fields-server.ts` reads the setting. Anything that
  leaves the admin (Content API, inlined script data, webhooks) goes through
  `publicExtras`.
- `site-notice.ts`: the one-line site announcement (`core.notice.*`) — pure rules shared
  by the settings validator and `site-notice-server.ts` (`getSiteNotice()`, read by public
  frames; dates count in the site time zone, re-checked every request).
- `status-filter.ts`: multi-select status filters in list URLs (`?status=a,b`, repeated
  params and the old single value all parse; unknown values are reported).
- `utils.ts`: `cn(...)` etc.
- `observe/`: error reporting (GlitchTip / Sentry protocol). `sentry-options.ts` is
  pure + type-only imports on purpose — the Worker entry (`custom-worker.ts`) reaches
  it. `report.ts` decides where the DSN comes from and is the only place that binds
  the SDK at runtime.
- Don't import extension code here. Don't import UI here.
