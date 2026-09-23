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
- `security.ts`: origin check + nonce helpers (CSP).
- `rate-limit.ts`: shared `hitRateLimit` (D1 KV-style table).
- `utils.ts`: `cn(...)` etc.
- `observe/`: error reporting (GlitchTip / Sentry protocol). `sentry-options.ts` is
  pure + type-only imports on purpose — the Worker entry (`custom-worker.ts`) reaches
  it. `report.ts` decides where the DSN comes from and is the only place that binds
  the SDK at runtime.
- Don't import extension code here. Don't import UI here.
