# (admin) META

- Admin shell lives here: `layout.tsx` wraps every page with sidebar + shell.
- `login/` + `setup/`: pre-auth entry surfaces.
- `admin/`: post-auth dashboard — ext, extensions, media, settings, users.
- `admin/ext/[extId]/[[...page]]`: declarative + code-extension admin page dispatch.
- Code extensions MAY contribute extra admin pages from `extensions/<id>/admin/`.

This route group is the **only** path through which the /admin shell renders.
