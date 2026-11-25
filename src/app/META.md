# app META

- `(admin)/`: admin pages — login, setup, CMS dashboard, settings, users, media, extension admin
- `(public)/`: unauthenticated public routes; extension-driven content
- `global-error.tsx`: the last error boundary (replaces the whole document). A chunk that will not load (a page from before the last deploy) reloads the page once per URL per minute (`lib/chunk-reload.ts`); anything else, or a second failure, shows `site-error.tsx`. Core; sites do not edit it.
- `site-error.tsx`: what `global-error.tsx` shows (`SiteError({ reloading, reload })`, `SITE_ERROR_LANG`). Site-owned, like `site.css`.
- `api/`: server-side endpoints (auth, extensions dispatch, callback, files, media, registry, settings, users, setup)

URL layer only. Page/business logic lives in `src/ext/` and `src/components/`.
