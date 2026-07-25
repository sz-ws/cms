# app META

- `(admin)/`: admin pages — login, setup, CMS dashboard, settings, users, media, extension admin
- `(public)/`: unauthenticated public routes; extension-driven content
- `api/`: server-side endpoints (auth, extensions dispatch, callback, files, media, registry, settings, users, setup)

URL layer only. Page/business logic lives in `src/ext/` and `src/components/`.
