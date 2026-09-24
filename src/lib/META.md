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
- `public-csp.ts`: script hosts of approved declarative scripts, read straight from the
  D1 binding (runs in the edge middleware, so no drizzle / zod). The middleware uses
  `cachedApprovedScriptHosts`, memoised per isolate behind a version stamp.
- `rate-limit.ts`: shared `hitRateLimit` (D1 KV-style table).
- `extra-fields.ts`: additional fields an admin adds per content type
  (`core.content.extraFields`; values in `data.extra`). Pure (zod only) so the settings
  manager and editors share it; `extra-fields-server.ts` reads the setting. Anything that
  leaves the admin (Content API, inlined script data, webhooks) goes through
  `publicExtras`.
- `utils.ts`: `cn(...)` etc.
- `observe/`: error reporting (GlitchTip / Sentry protocol). `sentry-options.ts` is
  pure + type-only imports on purpose — the Worker entry (`custom-worker.ts`) reaches
  it. `report.ts` decides where the DSN comes from and is the only place that binds
  the SDK at runtime.
- Don't import extension code here. Don't import UI here.
