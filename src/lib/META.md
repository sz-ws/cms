# lib META

- Framework glue that does not live inside any specific feature.
- `auth.ts`: session + cookie + role gating.
- `cf.ts`: Cloudflare env accessors (`getEnv`, `getDB`, `getStorage`).
- `db.ts`: drizzle wrapper (uses `getDB()`).
- `security.ts`: origin check + nonce helpers (CSP).
- `rate-limit.ts`: shared `hitRateLimit` (D1 KV-style table).
- `utils.ts`: `cn(...)` etc.
- Don't import extension code here. Don't import UI here.
