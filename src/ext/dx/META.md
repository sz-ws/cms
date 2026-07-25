# dx META

- Declarative extension interpreter (core-v2 §3).
- Bridge: DB-stored manifest → runtime `Extension`.
- Subdirs:
  - `manifest.ts`: zod schema + `parseManifest()`.
  - `runtime.ts`: dynamic-imported `getExtRuntime()` accessors (breaks registry↔loader TDZ).
  - `loader.ts`: assembles `ExtRuntime`.
  - `interpret.tsx`: row → `Extension` translator.
  - `surfaces.ts`: progressive override surface-id scheme.
  - `content-provider.ts`: default ContentProvider over shared `contents`.
  - `crud.ts`: auto-CRUD API route builders.
  - `webhook.ts`: `on:` action webhook dispatcher.
  - `route-matcher.ts`: pure compile/match for public routes (no ReDoS).
  - `public-create.ts`: public anonymous create payload sanitizer.
  - `views/`: generic declarative UI surfaces (platform-level — see its own META).
  - `fields/`: per-type field components + value shapers.
- Generic layers only. Extension-specific UI/surfaces do NOT belong here.
