# dx/views META

- **Generic** declarative UI surfaces used as fallbacks.
- Lives here iff it satisfies BOTH:
  - Reusable across every declarative content type (not tied to any one extension).
  - No auth/permissions assumption (admin surfaces assume `requireAuth` at dispatch).
    1.50.0: the admin collection, form and inbox surfaces read `canEditCurrentPage()`
    (lib/access-guards.ts) only to hide write controls from a view-only custom role;
    the CRUD API still enforces access.
- Current set:
  - `CollectionView` (admin collection).
  - `FormViewPage` + `FormView` (admin create/edit; ALSO used for public `view:"form"` via `mode:"public"`).
  - `ListView` (public list).
  - `DetailView` (public detail).
- **DO NOT** add extension-specific components here. An extension's own frontend kit
  belongs under `extensions/<id>/` — never imported by manifest, never living in this dir.
- Progressive override (per surface) is handled via `src/ext/overrides.ts`,
  keyed by `surfaceIds.*` from `src/ext/dx/surfaces.ts`.
