# (public) META

- Unauthenticated public surface.
- `[[...slug]]/page.tsx`: every public URL, the home page included. Dispatch into extension `publicRoutes` (site layer first, then agency, then plugins; a route matching `[]` is the home, else `filter:publicHome`, else the welcome page) and per-page `generateMetadata` / `generateViewport` (route `metadata` + `PublicMetadata` / `PublicViewport` steps). Rendered on first visit and stored whole (2.0 page cache; `dynamic = "error"`, so nothing here may read cookies, headers or searchParams). Rules: `src/ext/public-pages.ts`; how a site uses it: `src/ext/META.md` "A site supplies its own public pages".
- `layout.tsx`: the frame (`components/PublicFrame.tsx`, slot `PublicFrame`): announcement bar, `publicHeader`, content, `publicFooter`, `publicWidgets` by default. In the layout so it persists across client-side navigation; it does not know the URL (a frame that differs by URL uses `usePathname()` in a client component).
- `not-found.tsx`: the public 404, inside the layout's frame (2.x; before, the root 404 outside it), content from slot `PublicNotFound` (default: `components/NotFoundMessage.tsx`, the root 404's content).
- `site-notice.tsx`: the default frame's announcement bar (settings → Announcement), above the header.
- No auth, no admin chrome. Sites never delete or shadow these files; they register routes and fills from their site-layer plugin.
