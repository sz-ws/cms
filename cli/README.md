# @sz.ws/cms — `cms` / `sz-ws-cms`

CLI for the sz.ws CMS. Four commands:

| Command | Purpose |
|---|---|
| `cms setup` | Connect repo to your Cloudflare account: create D1 / R2, fill ids back into `wrangler.jsonc`, apply migrations, set three secrets (`SECRETS_KEY`, `AUTH_PEPPER`, `SETUP_TOKEN`) |
| `cms secrets` | Ensure those three secrets exist on the **deployed** Worker. Run automatically by the repo's `postdeploy` hook, because `wrangler secret put` needs a Worker that already exists |
| `cms add <id>` | Install code extension: fetch files from registry → write to `extensions/<id>/` → patch `extensions/registry.ts`, then ask for the extension's declared settings |
| `cms preflight` | Read-only: list extension settings that are still unset. `--gate` exits non-zero on missing required ones (used by the repo's `predeploy`) |

Both support fully non-interactive execution (`--yes` / `--non-interactive`) and `--dry-run`.

---

# `cms setup`

Replaces manual steps in `DEPLOY.md`. Run in the CMS repo root:

```bash
pnpm exec wrangler login    # Manual step — CLI does not touch credentials
npx @sz.ws/cms setup
```

| Flag | Meaning |
|---|---|
| `--config <path>` | Path to wrangler config file (default `./wrangler.jsonc`) |
| `--dry-run` | Detect and print plan only. **Detection commands still run** (otherwise the printed plan would be inaccurate), but no resources created, no files modified |
| `--yes`, `-y` | Skip all confirmation prompts (for CI); `--non-interactive` is equivalent |
| `--skip-migrations` | Do not apply `migrations/` |
| `--skip-secrets` | Skip secrets setup (final message will still remind you) |

## What it does

Processes each D1 / R2 resource from `wrangler.jsonc` — resource list comes from the config file itself, not hardcoded in the CLI, so adding or removing bindings later does not require CLI changes.

1. **Login check** (`wrangler whoami`) — stops here if not logged in and prints instructions.
2. **Discovery**: `wrangler d1 list --json` to match names by UUID, `wrangler r2 bucket info` to confirm each bucket.
3. **Create missing resources**: `wrangler d1 create` / `wrangler r2 bucket create`.
4. **Fill IDs back into** `wrangler.jsonc` (see next section).
5. **Apply migrations**: only for D1 databases that **declare `migrations_dir`**. `cms-tag-cache` has no such field; its `revalidations` table is created by `opennextjs-cloudflare deploy`'s populate-cache step (schema belongs to OpenNext; hand-copying into version control drifts).
6. **Three secrets** (`SECRETS_KEY`, `AUTH_PEPPER`, `SETUP_TOKEN`): if already present, skipped and **never overwritten**. When newly set, CLI generates 32-byte random values and pipes them via **stdin** to `wrangler secret put` — not passed via argv (visible to `ps`), not left in shell history, not printed to the terminal, no local copy kept. On a **first** setup the Worker does not exist yet, so this step cannot run at all; `cms secrets` (below) picks it up right after the first deploy.

## Idempotent / interrupted midway

Each step inspects what exists on the account before deciding to act, rather than tracking what it has done. So **just re-run directly**:

- D1 databases found by **name** in `d1 list`; if found, existing UUID is reused — no duplicate created.
- R2 checks `bucket info` first; if bucket creation hits `already exists`, that counts as success.
- `wrangler.jsonc` values that are already correct do not trigger writes (file mtime unchanged).
- Migrations already have applied tracking; re-running is a no-op.
- If interrupted mid-run, **already-fetched IDs are written back to config first** — otherwise the user would think nothing succeeded.

## Why not `JSON.parse` to edit `wrangler.jsonc`

The config file has inline comments on nearly every field (explaining why `main` points to `custom-worker.ts`, why a second `database_id` placeholder exists, etc.). Those comments *are* the documentation. `JSON.parse` → modify → `JSON.stringify` strips all comments and reformats.

So `cli/src/jsonc.ts` is a JSONC parser that tracks **character offsets**: edits replace only the literal value's byte range, leaving everything else unchanged — comments, indentation, trailing commas, key order all preserved.

Side benefit is safety: the edit range can structurally only land on `d1_databases[].database_id`; `main` / `triggers` / `assets` / `services` **cannot be touched**. Before writing, the file is re-read and offsets recalculated, avoiding conflicts with other processes editing the same config.

## Exit codes (setup)

| Code | Meaning |
|---|---|
| 0 | Success (includes "all ready, nothing to do") |
| 7 | Preconditions not met: not logged in, cannot read / parse config, `d1 list` fails |
| 8 | A wrangler operation failed (resource creation / migrations / file write) |
| 9 | User cancelled at confirmation prompt (no side effects) |

When `d1 list` fails, the command deliberately **does not proceed** — without that list, it cannot determine which resources already exist, and proceeding would risk duplicate databases.

## What it does not do

`wrangler login` (touches credentials), `pnpm run deploy`, open `/setup` to create the first admin, set `core.siteUrl`. These are listed in the final message for manual completion.

---

# `cms secrets`

Ensures `SECRETS_KEY` / `AUTH_PEPPER` / `SETUP_TOKEN` exist on the **deployed** Worker. That is the whole command — it creates nothing else.

```bash
npx @sz.ws/cms secrets            # generate whatever is missing
npx @sz.ws/cms secrets --dry-run  # report only
```

The repo wires it to `postdeploy`, so `pnpm run deploy` finishes the job by itself. It exists as a separate command because `wrangler secret put` needs a Worker that already exists: during the first `cms setup` there is nothing to attach a secret to, and the old advice ("deploy, then run setup again") made people repeat every other setup step for nothing.

- Existing keys are **never overwritten**. Rotating `SECRETS_KEY` turns every stored encrypted setting into gibberish; rotating `AUTH_PEPPER` makes every existing password uncomputable; rotating `SETUP_TOKEN` can lock out a site that has no admin yet.
- Only a **newly created** `SETUP_TOKEN` has its value printed — you need it to create the first admin, and `wrangler` cannot read a secret back. `SECRETS_KEY` and `AUTH_PEPPER` values are never shown, anywhere.
- If the secret list cannot be read (Worker not deployed, not logged in, network down), it exits non-zero **without writing anything** — "cannot see" is not "not set". The `postdeploy` wrapper turns that into a loud warning plus manual commands and still exits 0, because the deploy itself already succeeded.

---

# `cms add <id>`

Code-extension installer. Automates "fetch files from registry → write to `extensions/<id>/` → patch `extensions/registry.ts`"; DB row, build, and deploy remain manual (spec: `docs/spec-szws-cms-cli.md`).

## Usage

Run in the CMS repo root:

```bash
npx @sz.ws/cms add <id>                # Direct run, no install needed
cms add <id>                            # If globally installed
```

| Flag | Meaning |
|---|---|
| `--source <url>` | Registry base URL (default `https://raw.githubusercontent.com/sz-ws/registry/main`; supports `file://` for local testing) |
| `--token <t>` | Access token for private registry (also reads `SZWS_REGISTRY_TOKEN` env var; GitHub PAT / Gitea deploy token both work; sent as `Authorization: token <t>`) |
| `--dry-run` | Print what would be done, do not write to disk or modify files |
| `--force` | Overwrite existing `extensions/<id>/` (registry.ts patch is naturally idempotent, no duplicate inserts) |
| `--non-interactive` | Non-interactive (implies `--force`); conflicts still abort |
| `--skip-core-check` | Skip coreApi compatibility check (see next section). Escape hatch during squash or when `CORE_API_VERSION` has been locally modified; incompatibility still warns |

## Exit codes (add)

| Code | Meaning |
|---|---|
| 0 | Success (includes routing hint for declarative id, idempotent on re-run) |
| 1 | `<id>` not found / invalid id / conflict across sources |
| 2 | File fetch failed (network, 404, size cap, 401 missing token) |
| 3 | `extensions/<id>/` already exists and no `--force` |
| 4 | `extensions/registry.ts` patch failed (not in CMS repo root / format unrecognized) |
| 5 | Unknown error |
| 6 | Extension `coreApi` incompatible with local core (see next section; `--skip-core-check` overrides) |

## coreApi compatibility check

The registry index entry's `coreApi` is a semver range (e.g., `^1.5.0`). Before install, CLI extracts `CORE_API_VERSION` from local `src/ext/version.ts` using regex, then checks compatibility with the same semantics as `src/ext/semver.ts` (`1.2.3` / `^1.2.3` / `~1.2.3` / `>=1.2.3`):

| Situation | Behavior |
|---|---|
| Compatible | Install normally (`--dry-run` prints the check result) |
| Incompatible | **exit 6**, no files written, `registry.ts` untouched; message lists requirement / current / three paths forward |
| Unparseable range format (`>1.0.0`, `1.x`, etc.) | Treat as incompatible (fail closed, same as core) + explain supported formats |
| Cannot read local `CORE_API_VERSION` | Warn only, continue install (CLI missing info ≠ user error; core still guards at Enable step) |

Without blocking, an incompatible extension installs → rebuilds → deploys successfully, only failing when admin clicks Enable, caught by `enableExtension()`'s `CoreApiIncompatible` check — failure point too far from root cause.

> CLI is a standalone Node binary, **does not import `src/`** (would pull in entire Next module graph), so versions are extracted as strings and semver logic is re-implemented in `cli/src/coreapi.ts`. **If `src/ext/semver.ts` semantics change, `cli/src/coreapi.ts` must sync**, otherwise CLI-approved extensions still fail at Enable.

## File list: `files[]` vs heuristic

When registry index entry has `files: string[]`, that list is authoritative and CLI fetches all listed files (supports subdirectories). Without it, CLI falls back to **heuristic**: probes a fixed set of flat filenames. This pattern has known gaps — it **does not traverse subdirectories** (example: `cron`'s `worker/` three files are missed), so CLI explicitly warns the list is guessed and may be incomplete. Heuristic probes treat only 404 as "file does not exist"; timeouts / 401 / size cap errors abort (exit 2), no silent incomplete fetches. Long-term fix is for every code entry in registry to declare `files[]`.

## Settings interview (after install)

If the installed extension ships a `manifest.json` with `settings[]`, `add` asks
for each one and splits the answers by a **hard rule**:

| Setting | Lands in |
|---|---|
| `secret: false` | the `vars` block of `wrangler.jsonc` (committed) |
| `secret: true` | `.dev.vars` (local, gitignored) + a printed `wrangler secret put <KEY>` line |

`secret: true` values are **never** written to `wrangler.jsonc` — this repo is
public, so that would publish them. Secret input is not echoed to the terminal
and never appears in the transcript or in `--json` output.

The CLI does **not** run `wrangler secret put` for you: at install time you may
not be logged in to Cloudflare, and the Worker may not exist yet. It prints the
commands and you run them after deploying.

Keys are namespaced as `EXT_<EXTENSION>_<SETTING>` (for example
`newebpay` + `hashKey` → `EXT_NEWEBPAY_HASH_KEY`). `vars` and Worker secrets are
one flat namespace per Worker, so an unprefixed `apiKey` from two extensions
would silently overwrite each other.

Non-interactive runs (`--yes` / `--non-interactive` / no TTY) skip the interview
and only print what still needs setting — writing defaults would create fields
that look configured but are not.

---

# `cms preflight`

```bash
sz-ws-cms preflight          # list everything that is unset, read-only
sz-ws-cms preflight --gate   # exit non-zero if a required setting is missing
```

Scans `extensions/*/manifest.json`, and for every declared setting checks the
`vars` block (non-secret) or `wrangler secret list` (secret). Output is split
into three sections on purpose (exit codes: `0` clean, `10` gate blocked):

| Section | Meaning |
|---|---|
| `verified` | confirmed to have a value |
| `missing — required` | required, and confirmed absent — `--gate` stops the deploy (exit 10) |
| `cannot be verified before deploy` | not confirmed either way |

The third section is the point of the command. Extension settings ultimately
live in the D1 `settings` table, which the CLI cannot reach before a deploy —
without that section an entirely unconfigured site would print all green.

**Not being logged in to Cloudflare does not fail the command.** If
`wrangler secret list` cannot be read, secret checks degrade to "cannot verify"
and the run continues. `--gate` does not block on those either: on a first
deploy the Worker does not exist yet, so that query always fails — blocking
would make the first deploy impossible. Those cases get a loud warning that says
explicitly that the value was *not checked*, rather than *not set*.

`--gate` is wired into the repo's `predeploy` via `scripts/preflight.mjs`, and
deliberately not into `prebuild` / `predev` / `prepreview` / `pretest`.

## Output

Human-facing output — progress, steps, prompts, warnings, errors — goes to
**stderr**. stdout is reserved for results, so piping and redirecting behave:

```bash
cms setup 2> setup.log          # keep the transcript, stdout stays clean
cms add blog --json | jq .ok    # stdout is a single JSON object
```

| Goes to stdout | Everything else |
|---|---|
| `--version`, `--help` — the answer *is* the result | stderr |
| `--json` — one object: `{ ok, exitCode, command, id?, events?, messages[] }` | stderr |

Secret values entered during the `add` settings interview never appear in either
stream, nor in the `--json` transcript.

`--json` still writes the human transcript to stderr, so you lose nothing by
turning it on. `events` is present for `setup` (structured step records);
`messages` is the flat transcript, present for both commands.

## Develop

CLI is intentionally **zero-dependency**: `npx @sz.ws/cms` installs on-demand with fast cold startup, `pnpm test:cli` stays pure Node and completes in under 1 second. Terminal UI (`cli/src/ui.ts`) is hand-written, no prompt package like `@clack/prompts` — `cli/` is not a pnpm workspace member, so dependencies must be declared again in root `package.json` to install, and versions drift. 

All Cloudflare-touching commands use an **injected Executor** (`cli/src/exec.ts`); tests assert against a fake executor "what commands were sent", never touching real accounts.

CLI is pure Node (not in cloudflare workers test pool), source in `cli/src/`:

```bash
pnpm cli:build        # tsc -p cli/tsconfig.json → cli/dist/
pnpm cli:typecheck
pnpm test:cli         # vitest run --config vitest.cli.config.ts (node environment)
```

Published as `@sz.ws/cms`, with two bins: `cms` and the long alias `sz-ws-cms`.

Manual steps after CLI completes (CLI prints these): apply migrations (`pnpm db:migrate:local` / `:remote`), INSERT extensions row in admin's Installed tab, `pnpm build && wrangler deploy`.
