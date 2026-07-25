# ext META

- Extension runtime (core-v2 spec §2.1–§3.6).
- Two flavours:
  - **code extensions**: bundled at build, contribute React components + API handlers + migrations via `extensions/<id>/`.
  - **declarative extensions**: stored as manifests in D1 (`declarative_extensions`); interpreted by `dx/` on every page render.
- Subdirs:
  - `dx/`: declarative interpreter (manifest, runtime, fields, views, content-provider, dispatch).
  - `providers/`: provider registry + capability layer (core-v2 §2.2).
  - `loader.ts`: merges code + declarative into one `ExtRuntime`.
  - `overrides.ts`: progressive override registry (per-surface code replacement).
  - `services.ts`: per-request scoped service bundle.
  - `types.ts`: shared Extension / ApiRoute / PublicRoute / HookName contract.
  - `hooks.ts`: typed action/filter bus.
  - `semver.ts`: coreApi ↔ CORE_API_VERSION range comparison.
  - `version.ts`: CORE_API_VERSION constant.
