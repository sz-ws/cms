# admin META

- Post-auth dashboard surfaces.
- Sidebar menu + topbar come from this layout.
- Subdirs are functional groups: `ext` (per-extension admin), `extensions` (extension registry), `media` (R2 library), `settings` (ext settings), `users` (admin user mgmt).
- Extension-specific dashboard tiles come from `extensions/<id>/admin/` (code extensions) or `adminPages` in declarative manifests.
