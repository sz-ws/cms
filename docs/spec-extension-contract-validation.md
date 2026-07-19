# Extension Contract Validation (Core API 1.18.0)

Status: implemented.

## Goal

Make extension declarations an authoritative install/runtime contract rather than UI hints. Invalid values and broken references fail before persistence; settings, install prompts and content writes share the same required-value semantics.

## Setting contract

`SettingField` supports optional `required: true` for code and declarative extensions.

- `text`: string
- `textarea`: string or JSON-serializable value (preserves existing array/object settings)
- `number`: finite number
- `boolean`: boolean
- `select`: string present in `options[].value`
- Non-select settings must not declare `options`.
- Required text is trim-aware; whitespace-only values are missing.
- Settings controls expose a stable label/control association and required state to assistive technology.
- A required setting may have an empty initial default so an extension can install in an explicit "not configured" state. Explicitly saving that empty value is rejected.
- Secret settings must use an empty default; secrets enter through prompts/settings and are encrypted before persistence.
- `core.registrySources` additionally requires an array of HTTPS strings or source objects before token extraction.

`PUT /api/settings` returns structured validation failures:

```json
{
  "error": "invalid_values",
  "fields": [{ "key": "ext.example.apiKey", "code": "required" }]
}
```

## Declarative manifest checks

Installation rejects:

- Setting defaults whose type/options do not match their field.
- Duplicate select option values.
- Duplicate content type names, field keys, setting keys, install prompt keys, admin slugs or public route patterns.
- Duplicate nested field keys, block names or block field keys.
- `slugField`, admin page, public route, schedule or custom API references to undeclared content types/fields.
- Webhook `secretSetting` references that are absent or not marked `secret: true`.
- Unknown declarative hook names.
- Install prompt type or secret flags that differ from their referenced setting.
- Login providers without `clientId`, secret `clientSecret`, or `openid` in explicit scopes.

These checks are install-time and fail-loud; runtime no longer silently omits the affected surfaces.

Declarative installation prepares stylesheet, encrypted setting values and migration statements before mutation, then commits migrations, migration markers, the enabled manifest row, defaults and prompted values in one D1 batch. A failure rolls back the whole install/update unit; hooks and cache invalidation run only after commit.

Secret defaults and prompted secret values both pass through the same pre-commit encryption path. A concurrent stale install/update rolls back and returns a conflict rather than claiming that caller-specific prompts/source/assets converged. Post-commit cache refresh and hook dispatch are best-effort: a refresh failure is logged but does not turn an already committed install into an ambiguous 500 response.

Updates may add setting keys, but may not remove an existing key or change its type, `secret`, `required`, or ordered select options contract. This prevents stale settings requests and remove/reintroduce cycles from bypassing the storage contract. Authors must introduce a new key and an explicit migration for contract changes.

Migration arrays are immutable and append-only: an update must preserve the prior SQL prefix byte-for-byte and may only append new statements. Every install/update batch first claims the exact `updatedAt` revision it observed through a unique marker; only one caller can commit from that revision. Concurrent or stale batches fail and roll back with a conflict, including requests that have no new migrations.

Declarative enable/disable operations participate in the same revision-claim protocol. Uninstall is one atomic batch: it claims the current revision, removes settings/content/manifest and positional migration markers, but retains revision claims as tombstones. A reinstall reads the latest tombstone revision, executes migrations from a clean positional history, and cannot be raced by an already-prepared stale update. Commit errors are classified as stale conflicts only for the unique claim/marker constraint; unrelated DDL or storage failures remain server errors.

Core multi-setting saves also prepare serialization/encryption first and commit in one D1 batch. The `settings:saved` hook is post-commit best-effort, so a hook failure cannot turn committed values into an ambiguous API failure.

## Code extension checks

`defineExtension()` validates settings, migrations, uninstall migrations, admin pages and public routes, and rejects duplicate:

- Setting keys
- Migration/uninstall IDs
- Admin page slugs
- API method/path pairs
- Provider capability/id pairs

## Compatibility

This is Core API `1.18.0` because `SettingField.required` is a new optional extension surface. Extensions adopting it must declare `coreApi: "^1.18.0"`. Existing valid extensions remain caret-compatible; no existing extension version bump is required unless its own manifest changes.
