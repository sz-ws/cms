# (public) META

- Unauthenticated public surface.
- `[[...slug]]/page.tsx`: the home page (`filter:publicHome`) and dispatch into extension `publicRoutes`. Rendered on first visit and stored whole (2.0 page cache; `dynamic = "error"`, so nothing here may read cookies, headers or searchParams).
- No auth, no admin chrome.
- Code extensions can ship public UI under `extensions/<id>/public/` and register a `publicRoute`.
- `layout.tsx` draws the site announcement (`site-notice.tsx`, settings → Announcement) above the header.
