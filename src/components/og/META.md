# og META

- OG (Open Graph) image templates used for share previews / changelog hero / release notes / product cards, etc.
- Sourced from OGImageCN (Aniket Pawar) — a Satori-based, shadcn-compatible collection.
- Used inside the CMS by future store / changelog / release surface.
- Not part of the generic `dx/views` surface — these are platform-level visual assets.
- Stored under `src/components/og/` keyed by their OGImageCN slug so additional components are easy to add.

## Conventions

- Each file is a single React export (default-named after the OGImageCN slug) consuming `version / date / title / items / brand / logo` style props.
- Inline `style={{ ... }}` is intentional — Satori reads inline styles only.
- Components are inert without a rendering pipeline; they are rendered by `workers-og`'s `ImageResponse()` in `src/app/api/og/[extId]/[type]/[slug]/route.tsx`.
- **Not `next/og`** — it compiles wasm at runtime, which Cloudflare Workers forbids (`Wasm code generation disallowed by embedder`). Reasons and the three build-time gotchas are documented in that route's header.
- Templates must supply a font for CJK. Without one satori renders tofu boxes **and reports no error**.
