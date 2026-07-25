# api META

- All server-side endpoints.
- `auth/*`: session login/logout.
- `callback/*`: provider callback ingress (payment/extraction/...).
- `ext/[extId]/*`: extension API dispatch (auto-CRUD for declarative content).
- `extensions/*`: extension registry API (install/uninstall).
- `files/*`: R2-backed file streaming.
- `media/*`: media library (upload/list/delete).
- `registry/*`: registry install endpoints.
- `settings/*`: extension settings persistence.
- `users/*`: admin user CRUD.
- `setup`: first-run bootstrap.
- Server-only. Do not import client components here.
