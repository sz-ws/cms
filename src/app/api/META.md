# api META

- All server-side endpoints.
- `auth/*`: session login/logout.
- `callback/*`: provider callback ingress (payment/extraction/...).
- `ext/[extId]/*`: extension API dispatch (auto-CRUD for declarative content).
- `extensions/*`: extension registry API (install/uninstall).
- `files/*`: R2-backed file streaming.
- `media/*`: media library (upload/list/delete).
- `mcp`: AI connections' MCP endpoint (bearer from `oauth/*`); `oauth/{register,token,revoke}`
  for the apps, `oauth/authorize` for the consent screen's buttons; `ai-connections/[id]`
  disconnects from Settings (1.59.0). Discovery lives in `app/.well-known/`.
- `registry/*`: registry install endpoints.
- `roles/*`: custom staff roles (admin only; 1.50.0).
- `settings/*`: extension settings persistence.
- `users/*`: admin user CRUD.
- `setup`: first-run bootstrap.
- Server-only. Do not import client components here.
