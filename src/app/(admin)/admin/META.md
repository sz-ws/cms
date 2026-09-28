# admin META

- Post-auth dashboard surfaces.
- Sidebar menu + topbar come from this layout.
- Subdirs are functional groups: `ext` (per-extension admin), `extensions` (extension registry), `media` (R2 library), `settings` (ext settings), `users` (admin user mgmt), `roles` (1.50.0: roles and access — presets read-only, custom roles as a per-page None / View / Edit matrix).
- Extension-specific dashboard tiles come from `extensions/<id>/admin/` (code extensions) or `adminPages` in declarative manifests.
- Dashboard (`page.tsx`): plugin cards (`dashboardCards`, `dashboardStats`) come first, then the revenue card (1.61.0, `Extension.dashboardRevenue`): `components/admin/dashboard/revenue-data.ts` loads the period from the URL (`lib/report-period.ts`) and asks each plugin for this and the previous period; `RevenueCard.tsx` draws it with the shared `components/admin/report/ReportPeriodControl` and `RevenueChart`.
- `users/`: `users-data.ts` loads everyone plus the plugins' member facets (`Extension.memberFacets`, see `src/ext/member-facets.ts`); `users-filter.ts` is the one filter the page and `GET /api/users/export` share (search, dates, role, facets); `UserFacetSections.tsx` draws a facet's lines and links in the member sheet.
