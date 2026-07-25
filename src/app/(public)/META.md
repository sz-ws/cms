# (public) META

- Unauthenticated public surface.
- `[...slug]/page.tsx`: dispatch into extension `publicRoutes`.
- No auth, no admin chrome.
- Code extensions can ship public UI under `extensions/<id>/public/` and register a `publicRoute`.
