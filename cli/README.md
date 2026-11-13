# @sz.ws/cms — `cms` / `sz-ws-cms`

CLI for the open-source sz.ws CMS. Each user deploys to their own Cloudflare account; no sz.ws account or hosted control service is required.

| Command | Purpose |
|---|---|
| `cms status` | Read-only report: account and auth source, live version, URLs, D1 / R2 (ok / missing), leftover KV, pending migrations, managed secrets (names only), plugins |
| `cms doctor` | Checks with pass / warn / fail, each with a hint and the next command; includes the `preflight` settings checks. Exit 10 when a check fails |
| `cms login` | Sign in to Cloudflare through `cf`; reports where auth comes from when already signed in |
| `cms version list` | Uploaded Worker versions, newest first, with each one's share of traffic |
| `cms logs` | Live tail through the project's `wrangler tail` until Ctrl-C |
| `cms help [command]` | Help; `cms help --json` prints every command, flag, env variable, exit code and error code as data |
| `cms create <dir> --deploy` | Clone the project and continue through deployment and first-admin setup |
| `cms deploy` | Install dependencies, provision resources, build, apply migrations, deploy, initialize the site, and verify readiness |
| `cms setup` | Connect repo to your Cloudflare account: create D1 / R2, fill ids back into `wrangler.jsonc`, set the page-cache lifecycle rule, apply migrations, set three secrets (`SECRETS_KEY`, `AUTH_PEPPER`, `SETUP_TOKEN`) |
| `cms secrets` | Ensure those three secrets exist on the **deployed** Worker. Run automatically by the repo's `postdeploy` hook, because `wrangler secret put` needs a Worker that already exists |
| `cms add <id>` | Install code extension: fetch files from registry → write to `extensions/<id>/` → patch `extensions/registry.ts`, then ask for the extension's declared settings |
| `cms preflight` | Read-only: list extension settings that are still unset. `--gate` exits non-zero on missing required ones (used by the repo's `predeploy`) |

Deployment supports non-interactive execution (`--yes` / `--non-interactive`) and `--dry-run`.

## For agents and scripts (0.9)

```bash
cms help --json        # every command, flag, env variable, exit code and error code
cms status --json      # what exists on Cloudflare for this site
cms doctor --json      # what is wrong, and the command that fixes it
```

`status`, `doctor`, `login`, `version list` and `logs` run on one declarative command table: the same table drives the parser, `cms help` and `cms help --json`, so help cannot drift from what the CLI accepts. The 0.x commands below are listed in that table too and keep their own flags, output and exit codes.

**Never prompts without a person.** The new commands are non-interactive when stdin or stdout is not a TTY, when `CI` is set, or with `--json`. A missing input is then an error with a code, never a prompt.

**One JSON object with `--json`.** stdout is exactly:

```json
{
  "ok": false,
  "command": "status",
  "data": null,
  "plan": [],
  "warnings": [],
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Not signed in to Cloudflare.",
    "hint": "Run `cms login` in a terminal, or set CLOUDFLARE_API_TOKEN to an API token (for CI and agents).",
    "next": ["cms login"]
  }
}
```

Prose (prompts, progress, warnings) goes to stderr. `cms logs --json` is the exception: stdout is wrangler's stream of JSON events, one per line.

**Exit codes of the new commands** (the string `error.code` carries the detail; `cms help --json` lists every code):

| Code | Meaning |
|---|---|
| 0 | Success, including nothing to do |
| 1 | Operation failed (`CONFIG_MISSING`, `WORKER_NOT_FOUND`, `CF_FAILED`, …) |
| 2 | Usage error: unknown command or flag, bad value — with "did you mean" |
| 3 | Needs the user: `AUTH_REQUIRED`, `CF_MISSING`, `NODE_TOO_OLD`, `ACCOUNT_AMBIGUOUS`, … |
| 4 | Refused for safety |
| 5 | `TRANSIENT`: Cloudflare kept failing after retries; safe to run again |
| 10 | `doctor` found failing checks |
| 130 | Cancelled (Ctrl-C at a prompt) |

An unknown command now exits 2 for every command, with a suggestion instead of the whole help.

### Cloudflare access through `cf`

The new commands read Cloudflare through `cf`, Cloudflare's own CLI (npm package `cf`, needs Node 22+). The CLI uses the site's `node_modules/.bin/cf` first, then `cf` on `PATH`. `cf` is still a beta whose commands change between releases, so the CLI checks its version: older than `1.0.0-beta.32` is refused (`CF_VERSION_UNSUPPORTED`), newer runs with a warning.

- **`cf` missing.** In a terminal the CLI asks once and installs it as a devDependency with the project's package manager (`pnpm add -D cf@1.0.0-beta.32` when there is a `pnpm-lock.yaml`). Answering No exits 3 and prints the command. Without a terminal: `CF_MISSING`, with the install command in `error.next`.
- **Not signed in.** In a terminal the CLI offers to run `cf auth login` (the browser flow). Answering No exits 3 and explains `CLOUDFLARE_API_TOKEN`. Without a terminal: `AUTH_REQUIRED`. `cms status` and `cms login` say where auth comes from ("signed in through cf", or "API token from CLOUDFLARE_API_TOKEN").
- **Account.** `--account`, then `CLOUDFLARE_ACCOUNT_ID`, then `account_id` in `wrangler.jsonc`, then the only account the login can see. With several and none chosen: a numbered list in a terminal (Ctrl-C cancels, nothing is written), `ACCOUNT_AMBIGUOUS` with the accounts in `data` otherwise.
- **Retries.** Rate limits, 5xx responses, dropped connections and Cloudflare's intermittent 7403 are retried twice (after 1 s and 3 s). If they persist, `status` reports the item as unknown with a `READ_FAILED` warning; other commands exit 5.
- **Read-only.** These commands send only reads (`cf auth whoami`, `workers get`, `workers deployments list`, `workers versions list`, `workers secrets list` — names only, `d1 list`, `d1 migrations list`, `r2 buckets list`, `kv namespaces list`). An API token for them needs read access to Workers Scripts, D1, Workers R2 Storage and Workers KV Storage.

`cms logs` is a thin pass-through to the project's `wrangler tail` (`cf` has no live tail for Workers), so it uses wrangler's own login or `CLOUDFLARE_API_TOKEN`. Arguments after `--` go to `wrangler tail` unchanged: `cms logs -- --status error`.

A 1.x site's leftover KV namespace (`<worker>-kv`, or an id still under `kv_namespaces`) shows in `status` as "not used by 2.0, safe to delete" and as a warning in `doctor`; nothing deletes it.

## One-command deployment

This workflow is implemented in the local development version and has not yet been published to npm. To use it from this checkout, run `pnpm cli:build`, then `node cli/dist/cli.js deploy --site-slug my-site`. The commands below describe usage after publication.

```bash
npx @sz.ws/cms create my-site --deploy
# Or, inside an existing CMS project:
npx @sz.ws/cms deploy --site-slug my-site
```

Use Node 22.12+ and pnpm. In an interactive terminal the CLI opens Cloudflare authorization if needed and asks for the account, site identifier, and initial administrator details. The authorization step gives `wrangler` the terminal, so its URL stays visible when the browser cannot open by itself. All resources remain in the selected user's Cloudflare account. With `create <dir> --deploy` the directory name becomes the site slug, so a name the slug rule rejects stops before anything is cloned; pass `--site-slug` to keep the directory name.

The workflow installs locked dependencies, reuses the existing resource setup, builds with OpenNext, checks the **64 MiB uncompressed** upload limit, then applies pending migrations and deploys. It creates only missing managed secrets, verifies their names, initializes `core.siteUrl` only if absent, creates the first administrator through the CMS setup API, and checks `/login` for HTTP 200. A failed readiness check exits non-zero even if the Worker upload succeeded; if migrations were applied but the upload did not happen, the summary says which databases are now ahead of the running Worker.

`--site-url https://cms.example.com` selects an existing custom domain for initialization and verification. Without it, the CLI uses the deployed Worker's `workers.dev` URL and reports that `core.siteUrl` was initialized to it — OIDC redirect URIs, payment callbacks, and absolute sitemap URLs are derived from that value, so rerun with `--site-url` (or change it in Settings) after attaching a custom domain. It does not register domains or change DNS. Existing users, secrets, and `core.siteUrl` values are preserved. Extension-specific third-party credentials remain application configuration; this command does not invent them.

For CI, provide Cloudflare authentication plus `CLOUDFLARE_ACCOUNT_ID`. A first deployment also needs `CMS_ADMIN_EMAIL`, `CMS_ADMIN_NAME`, `CMS_ADMIN_PASSWORD`, and `CMS_SITE_TITLE` as environment variables; a missing one is reported before the build starts, not after it. Never pass passwords in command-line arguments. The `CMS_ADMIN_*` values and `CMS_SETUP_TOKEN` are removed from the environment of every child process the CLI spawns, so install lifecycle scripts, the build, and `wrangler` never see them. Existing sites do not need administrator inputs again.

Interrupted first-admin setup resumes from a private, gitignored `.cms/bootstrap.json`, scoped to the Worker and database ID. Only the bootstrap token is stored there (file mode 0600); passwords and encryption keys are never persisted. The token file is removed after setup succeeds. If setup began outside this workflow and the original token is unavailable locally, supply `CMS_SETUP_TOKEN`; existing secrets are never rotated to recover it.

`cms deploy --dry-run` inspects resources and reports the workflow without installing dependencies, building, migrating, uploading, generating secrets, or making HTTP requests to the site. Read-only discovery runs through the project's own `node_modules/.bin/wrangler`, so a dry run needs `pnpm install` to have completed. On a fresh clone it stops with exit 7 and says so; run `cms deploy` without `--dry-run` instead, which installs the locked dependencies first. Repeat `cms deploy` with the same options after fixing any reported failure; it preserves existing resources and keys. `--skip-migrations` and `--skip-secrets` belong to the lower-level `setup` command and are rejected by `deploy`.

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

With the template's `wrangler.jsonc` that means: one D1 database `cms-<slug>-db` (bound twice, as `DB` and as `NEXT_TAG_CACHE_D1`; `--separate-tag-cache` gives the tag cache its own database), the media bucket `cms-<slug>-storage` (`STORAGE`) and the page-cache bucket `cms-<slug>-next-cache` (`NEXT_INC_CACHE_R2_BUCKET`). Public pages are stored whole in the page-cache bucket and the D1 table `revalidations` records when they were invalidated (see DEPLOY.md, "Public pages are stored whole"). No KV namespace: 2.0 does not use one.

1. **Login check** (`wrangler whoami`) — stops here if not logged in and prints instructions.
2. **Discovery**: `wrangler d1 list --json` to match names by UUID, `wrangler r2 bucket info` to confirm each bucket, `wrangler r2 bucket lifecycle list` on the page-cache bucket.
3. **Create missing resources**: `wrangler d1 create` / `wrangler r2 bucket create`.
4. **Fill IDs back into** `wrangler.jsonc` (see next section).
5. **Page-cache lifecycle rule**: on the bucket bound as `NEXT_INC_CACHE_R2_BUCKET`, adds the rule `expire-page-cache` (`wrangler r2 bucket lifecycle add <bucket> expire-page-cache incremental-cache/ --expire-days 30`). Stored pages are keyed by build id, so each deploy leaves the previous build's pages behind and nothing reads them again; the rule deletes objects under `incremental-cache/` 30 days after they were written. A page still in use that reaches 30 days is rendered again on its next request. The media bucket gets no rule.
6. **Apply migrations**: only for D1 databases that **declare `migrations_dir`**. `cms-tag-cache` has no such field; its `revalidations` table is created by `opennextjs-cloudflare deploy`'s populate-cache step (schema belongs to OpenNext; hand-copying into version control drifts).
7. **Three secrets** (`SECRETS_KEY`, `AUTH_PEPPER`, `SETUP_TOKEN`): if already present, skipped and **never overwritten**. When newly set, CLI generates 32-byte random values and pipes them via **stdin** to `wrangler secret put` — not passed via argv (visible to `ps`), not left in shell history, not printed to the terminal, no local copy kept. On a **first** setup the Worker does not exist yet, so this step cannot run at all; `cms secrets` (below) picks it up right after the first deploy.

## Idempotent / interrupted midway

Each step inspects what exists on the account before deciding to act, rather than tracking what it has done. So **just re-run directly**:

- D1 databases found by **name** in `d1 list`; if found, existing UUID is reused — no duplicate created.
- R2 checks `bucket info` first; if bucket creation hits `already exists`, that counts as success.
- The lifecycle rule is added only when the bucket has neither a rule named `expire-page-cache` nor another enabled rule that expires objects under `incremental-cache/` (or the whole bucket). A rule you changed by hand (another number of days, another name) is kept as it is. `wrangler r2 bucket lifecycle add` does not check names itself, so when the rule list cannot be read the rule is **not** added.
- `wrangler.jsonc` values that are already correct do not trigger writes (file mtime unchanged).
- Migrations already have applied tracking; re-running is a no-op.
- If interrupted mid-run, **already-fetched IDs are written back to config first** — otherwise the user would think nothing succeeded.

**Sites set up for core 1.x** need no extra command: re-run `cms setup` (or `cms deploy`, which runs the same step). It adds the lifecycle rule and leaves D1 / R2 and `wrangler.jsonc` as they are. If `wrangler.jsonc` still has the `CMS_KV` entry that 1.x setup wrote, it prints how to remove it and delete the namespace; it never deletes anything itself. See DEPLOY.md, "Upgrading a 1.x site to 2.0".

## Why not `JSON.parse` to edit `wrangler.jsonc`

The config file has inline comments on nearly every field (explaining why `main` points to `custom-worker.ts`, why a second `database_id` placeholder exists, etc.). Those comments *are* the documentation. `JSON.parse` → modify → `JSON.stringify` strips all comments and reformats.

So `cli/src/jsonc.ts` is a JSONC parser that tracks **character offsets**: edits replace only the literal value's byte range, leaving everything else unchanged — comments, indentation, trailing commas, key order all preserved.

Side benefit is safety: the edit range can structurally only land on the tenant names, `d1_databases[].database_id` and a missing `account_id`; `main` / `triggers` / `assets` / `services` **cannot be touched**. Before writing, the file is re-read and offsets recalculated, avoiding conflicts with other processes editing the same config.

## Exit codes (setup)

| Code | Meaning |
|---|---|
| 0 | Success (includes "all ready, nothing to do") |
| 7 | Preconditions not met: not logged in, cannot read / parse config, `d1 list` fails |
| 8 | A wrangler operation failed (resource creation / migrations / file write) |
| 9 | User cancelled at confirmation prompt (no side effects) |

When `d1 list` fails, the command deliberately **does not proceed** — without that list, it cannot determine which resources already exist, and proceeding would risk duplicate databases.

Lifecycle-rule problems never change the exit code: the site works without the rule, only old builds' pages stay in R2. If the rule list cannot be read or the rule cannot be added, the command prints a warning with the `wrangler r2 bucket lifecycle add` command to run by hand, and finishes the rest.

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
cms add <id>@<x.y.z>                    # A version the registry kept for older cores
```

A registry keeps an older version only when a release needs a newer core (it lists it under `versions` in
`registry.json`). When the latest does not fit your core, `add` names the kept version that does.

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
| 11 | Not activated for this registry key: the index lists the extension with `access` other than `granted`, or a file answers 402. No files are fetched; the provider's message is printed with control characters removed |

## Paid extensions

Every registry request carries `X-Registry-Protocol: 1`. A registry that sells extensions lists the ones your key has not been given with `access: "locked"` and answers 402 `not_entitled` for their files. `add` checks `access` before fetching anything and stops with exit 11; the price and the provider's contact are on the site's admin Store page. The CLI does not check licences after install: once files are in the site repo they are the site's code.

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
