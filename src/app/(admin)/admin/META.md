# admin META

- Post-auth dashboard surfaces.
- Sidebar menu + topbar come from this layout.
- Subdirs are functional groups: `ext` (per-extension admin), `extensions` (extension registry), `media` (R2 library), `settings` (ext settings), `users` (admin user mgmt), `roles` (1.50.0: roles and access — presets read-only, custom roles as a per-page None / View / Edit matrix).
- Extension-specific dashboard tiles come from `extensions/<id>/admin/` (code extensions) or `adminPages` in declarative manifests.
- `users/`: `users-data.ts` loads everyone plus the plugins' member facets (`Extension.memberFacets`, see `src/ext/member-facets.ts`); `users-filter.ts` is the one filter the page and `GET /api/users/export` share (search, dates, role, facets); `UserFacetSections.tsx` draws a facet's lines and links in the member sheet.
