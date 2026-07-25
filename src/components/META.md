# components META

- Reusable presentational + intent UI primitives.
- `admin/`: all admin-app widgets — shell, sidebar, nav, settings/tokens/passkeys/registry
  managers, dashboard motifs. Core-owned, one bounded folder (#18).
- `ui/`: theme-tokens-bound primitives (Button, Card, Input, ...) and intent variants.
  `ui/legacy.tsx` is the pre-shadcn thin Tailwind wrapper (former top-level `ui.tsx`);
  migrate call sites to the shadcn primitives over time.
- `og/`: OG-image render components (untouched by #18).
- No loose component files at the top level — only `admin/`, `ui/`, `og/`, this META.md.
- Anything reusable across admin **and** public belongs here, not in an extension.
- Extension-specific UI lives under `extensions/<id>/...`, not here.
