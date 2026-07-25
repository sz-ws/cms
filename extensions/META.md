# extensions META

- **Code extensions** (compile-time, bundled into the worker).
- One folder per extension id: `extensions/<id>/...`.
- Convention (code extensions):
  - `index.ts` (or named entry) — exports `defineExtension(...)`.
  - `admin/` — extension's own admin components / pages.
  - `public/` — extension's own public components / pages (the extension's frontend kit).
  - `migrations.ts` — DDL run on install.
  - Optional `overrides/<surfaceId>.tsx` — progressive override components.
- This is where an extension's frontend kit lives — never under `src/ext/dx/views/`.
- Manifest registry for code extensions lives elsewhere (`registry/` is mostly declarative; code extensions are registered by `extensions/registry.ts`).
