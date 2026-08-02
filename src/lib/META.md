# lib META

- Framework glue that does not live inside any specific feature.
- `auth.ts`: session + cookie + role gating.
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
