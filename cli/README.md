# @sz.ws/cms — `cms` / `sz-ws-cms`

CLI for the open-source sz.ws CMS. Each user deploys to their own Cloudflare account; no sz.ws account or hosted control service is required.

| Command | Purpose |
|---|---|
| `cms init <dir>` | Create a site project from the newest release tag of the template (`--deploy` continues with `cms deploy`) |
| `cms deploy` | Show a plan, then converge the site: resources, build, upload, migrate, go live, secrets, first admin, check |
| `cms status` | Read-only report: account and auth source, live version, URLs, D1 / R2 (ok / missing), leftover KV, pending migrations, managed secrets of the live version (names only), plugins |
| `cms doctor` | Checks with pass / warn / fail, each with a hint and the next command, plugin settings included. Exit 10 when a check fails |
| `cms login` | Sign in to Cloudflare through `cf`; reports where auth comes from when already signed in |
| `cms version list` | Uploaded Worker versions, newest first, with each one's share of traffic |
| `cms logs` | Live tail through the project's `wrangler tail` until Ctrl-C; `--since 1h` lists recent errors from Workers Logs instead |
| `cms rollback [version-id]` | Send all traffic back to an earlier version (the previous one by default); plan, then confirm |
| `cms domain list` / `add <host>` / `remove <host>` | Custom domains declared in `wrangler.jsonc`; applied at the next `cms deploy` |
| `cms secret list` / `set <NAME>` / `delete <NAME>` | Worker secrets; values only from stdin or a hidden prompt; managed secrets refused |
| `cms ci token` | The API token permissions the site's commands need, and which command needs which |
| `cms ci init` | Write `.github/workflows/cms.yml` to deploy or roll back by hand from GitHub Actions |
| `cms destroy` | Delete the site's Worker, D1, R2 buckets and declared KV after typing the Worker name; `--purge-objects` empties the buckets first |
| `cms plugin add <id>` | Install a code plugin: fetch files from a registry → `extensions/<id>/` → patch `extensions/registry.ts`, then ask for its settings |
| `cms plugin list` | Code plugins (version, newer version in the registry, settings still needed) and declarative plugins on the live site |
| `cms plugin configure <id>` | Run an installed code plugin's settings interview again |
| `cms plugin remove <id>` | Remove a code plugin's files and its `registry.ts` entry (plan, then confirm) |
| `cms upgrade` | Read-only: the site's core, the newest core of the template, and the migrations it adds |
| `cms help [command]` | Help; `cms help --json` prints every command, flag, env variable, exit code and error code as data |

Kept for one release (0.x names): `cms create` runs `cms init` with a notice; `cms setup` exits 2 and points at `cms deploy --dry-run`; `cms secrets` creates missing managed secrets (old `postdeploy` hooks call it); `cms preflight [--gate]` runs the plugin-settings checks of `doctor` (old `predeploy` hooks call it; `--gate` exits 10); `cms add` is `cms plugin add`. Removed flags (`--allow-shared-default-names`, `--separate-tag-cache`, `--skip-migrations`, `--skip-secrets`) exit 2 with what replaced them; `--site-slug` still works as `--name` with a notice, `--non-interactive` as `--yes`.

In this repository the CLI is source: `pnpm run deploy` (and `pnpm cms <command>`) runs `scripts/cms.mjs`, which builds `cli/dist` when it is older than `cli/src` and passes the command on.

## For agents and scripts

```bash
cms help --json        # every command, flag, env variable, exit code and error code
cms status --json      # what exists on Cloudflare for this site
cms doctor --json      # what is wrong, and the command that fixes it
```

Every command is in one declarative command table: the same table drives the parser, `cms help` and `cms help --json`, so help cannot drift from what the CLI accepts. Only `plugin add` (and its old name `add`) keeps the installer's own parser, output and exit codes.

**Never prompts without a person.** Commands are non-interactive when stdin or stdout is not a TTY, when `CI` is set, or with `--json`. A missing input is then an error with a code, never a prompt.

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

**Exit codes** (the string `error.code` carries the detail; `cms help --json` lists every code):

| Code | Meaning |
|---|---|
| 0 | Success, including nothing to do |
| 1 | Operation failed (`CONFIG_MISSING`, `WORKER_NOT_FOUND`, `CF_FAILED`, …) |
| 2 | Usage error: unknown command or flag, bad value — with "did you mean" |
| 3 | Needs the user: `AUTH_REQUIRED`, `CF_MISSING`, `NODE_TOO_OLD`, `ACCOUNT_AMBIGUOUS`, `PACKAGE_MANAGER_MISSING`, `DEPENDENCIES_MISSING`, `GIT_MISSING`, … |
| 4 | Refused for safety (`NAME_IN_USE`, `MANAGED_SECRET`, `BUCKET_NOT_EMPTY`) |
| 5 | `TRANSIENT`: Cloudflare kept failing after retries; safe to run again |
| 10 | `doctor` found failing checks |
| 130 | Cancelled: No to the plan, or Ctrl-C |

An unknown command exits 2 with a suggestion instead of the whole help. A program that is not installed (pnpm, git, the project's wrangler or opennextjs-cloudflare, …) is reported by name with how to get it, never as a raw `spawn … ENOENT`. Every "run it again" entry in `error.next` repeats the command as it was typed, flags included, so a dry run is suggested again as a dry run.

### Cloudflare access through `cf`

Commands read and change Cloudflare through `cf`, Cloudflare's own CLI (npm package `cf`, needs Node 22+). The CLI uses the site's `node_modules/.bin/cf` first, then `cf` on `PATH`. `cf` is still a beta whose commands change between releases, so the CLI checks its version: older than `1.0.0-beta.32` is refused (`CF_VERSION_UNSUPPORTED`), newer runs with a warning.

- **`cf` missing.** In a terminal the CLI asks once and installs it as a devDependency with the project's package manager (`pnpm add -D cf@1.0.0-beta.32` when there is a `pnpm-lock.yaml`). Answering No exits 3 and prints the command. Without a terminal: `CF_MISSING`, with the install command in `error.next`.
- **Not signed in.** In a terminal the CLI offers to run `cf auth login` (the browser flow). Answering No exits 3 and explains `CLOUDFLARE_API_TOKEN`. Without a terminal: `AUTH_REQUIRED`. `cms status` and `cms login` say where auth comes from ("signed in through cf", or "API token from CLOUDFLARE_API_TOKEN").
- **Account.** `--account`, then `CLOUDFLARE_ACCOUNT_ID`, then `account_id` in `wrangler.jsonc`, then the only account the login can see. With several and none chosen: a numbered list in a terminal (Ctrl-C cancels, nothing is written), `ACCOUNT_AMBIGUOUS` with the accounts in `data` otherwise.
- **Retries.** Rate limits, 5xx responses, dropped connections and Cloudflare's intermittent 7403 are retried twice (after 1 s and 3 s). If they persist, `status` reports the item as unknown with a `READ_FAILED` warning; other commands exit 5.
- **Reads and writes.** `status`, `doctor`, `version list`, `secret list`, `logs --since` and every `--dry-run` send only reads (`cf auth whoami`, `workers get`, `workers deployments list`, `workers versions list`, `workers secrets list` — names only, `d1 list`, `d1 migrations list`, `d1 query` with a `SELECT`, `r2 buckets list`, `r2 buckets lifecycle get`, `kv namespaces list`); an API token for them needs read access to Workers Scripts, D1, Workers R2 Storage and Workers KV Storage. `cms deploy`, `cms secrets`, `cms secret set/delete`, `cms rollback` and `cms destroy` also write (see `cms ci token` for the exact permissions).

`cms logs` is a thin pass-through to the project's `wrangler tail` (`cf` has no live tail for Workers), so it uses wrangler's own login or `CLOUDFLARE_API_TOKEN`. Arguments after `--` go to `wrangler tail` unchanged: `cms logs -- --status error`.

A 1.x site's leftover KV namespace (`<worker>-kv`, or an id still under `kv_namespaces`) shows in `status` as "not used by 2.0, safe to delete" and as a warning in `doctor`; nothing deletes it.

# `cms deploy`

```bash
cms deploy --dry-run          # read everything, print the plan, change nothing
cms deploy                    # show the plan, ask, apply
cms deploy --yes --json       # CI and agents: accept the plan, one JSON result
```

**What the site needs comes from `wrangler.jsonc`; what exists comes from your account** (read through `cf`). The difference is the plan: resources to create, `wrangler.jsonc` edits (site name, `account_id`, D1 ids), the page-cache lifecycle rule, migrations, missing managed secrets, the first administrator. In a terminal the plan is shown and you confirm it; `--yes` accepts it; `--dry-run` stops after it (`plan[]` in `--json`). Answering No changes nothing and exits 130. Without a terminal and without `--yes`, it exits 3 with `CONFIRMATION_REQUIRED`.

**Order.** For a Worker that already exists, a new version is uploaded without taking traffic, then migrations run, then that version goes live (100%):

```
dependencies → config → resources → build → upload (not live) → migrate → go live → secrets → site → check
```

For a site whose Worker does not exist yet, the order 0.x used and proved stays: `… → build → migrate → deploy → secrets → site → check`. (Uploading a version of a Worker that does not exist, and passing secrets with the upload, are not verified, so they are not relied on.)

| Step | What runs |
|---|---|
| Dependencies | the lockfile's package manager: `pnpm install --frozen-lockfile` (`npm ci`, `yarn`/`bun install --frozen-lockfile`) |
| Config | `wrangler.jsonc` edits in place, comments kept (site name for a new site, `account_id` when absent) |
| Resources | `cf d1 create`, `cf r2 buckets create`, ids written back; the page-cache rule with `cf r2 buckets lifecycle update` (the bucket's other rules kept) |
| Build | `opennextjs-cloudflare build`, then `scripts/split-server-chunks.mjs` when the site has it |
| Upload | `opennextjs-cloudflare upload` → `wrangler versions upload`; the version id is read from wrangler's `WRANGLER_OUTPUT_FILE_PATH` record |
| Migrate | `wrangler d1 migrations apply <db> --remote` |
| Go live / Deploy | `cf workers deployments create` (100% to the uploaded version) / `opennextjs-cloudflare deploy` for a first deploy |
| Secrets | only missing `SECRETS_KEY` / `AUTH_PEPPER` / `SETUP_TOKEN`, through `cf workers secrets update` with the value in a 0600 temp file; never rotated; "cannot read" is not "not set" |
| Site | `core.siteUrl` only when unset (`cf d1 query`); the first administrator through `/api/setup` when the site has no users |
| Check | `GET <url>/login` must answer 200 |

**Two logins.** Reads, resources, secrets and promotion go through `cf`; the build and upload go through the project's wrangler, which keeps its own login. In a terminal `cms deploy` offers `wrangler login` when needed; in CI set `CLOUDFLARE_API_TOKEN` (both tools read it) and `CLOUDFLARE_ACCOUNT_ID`.

**First run inputs.** A fresh template has no site name: `--name` (or `CMS_SITE_NAME`); Worker, D1 and R2 names derive from it, and a name whose resources already exist on the account is refused (`NAME_IN_USE`, exit 4). A site without users needs `--admin-email`, `--admin-name`, `--site-title` (or `CMS_ADMIN_EMAIL`, `CMS_ADMIN_NAME`, `CMS_SITE_TITLE`) and `CMS_ADMIN_PASSWORD` — the password only from the environment or a hidden prompt. In a terminal, missing inputs are asked for, and an invalid answer is explained and asked again (Ctrl-C cancels, 130); a value given by flag or env that is invalid fails at once (`BAD_VALUE`). Otherwise `INPUT_REQUIRED` lists the env names in `data.missing`. `CMS_ADMIN_*` and `CMS_SETUP_TOKEN` are removed from the environment of every child process.

**Failures.** Each step prints one line with its duration; child output goes to `.cms/logs/deploy-<time>.log` (gitignored), and a failing step names it. Every failure has its own `error.code` (`BUILD_FAILED`, `UPLOAD_REJECTED`, `MIGRATION_FAILED`, `PROMOTE_FAILED`, `DEPLOY_FAILED`, `SECRETS_UNREADABLE`, `SECRETS_FAILED`, `ADMIN_FAILED`, `HTTP_CHECK_FAILED`, …) and `data.state` says what changed:

| `data.state` | Live site |
|---|---|
| `nothing-changed` | unchanged |
| `resources-changed` | unchanged; resources or `wrangler.jsonc` changed |
| `version-uploaded` | unchanged; a new version exists without traffic |
| `schema-ahead` | still the previous version, now running against the new schema |
| `live` | the new version is live; a later step did not finish |

Ctrl-C stops at the current step and lists the completed ones (exit 130). Every step checks before it acts, so running `cms deploy` again continues from what is missing. An interrupted first-admin setup resumes from `.cms/bootstrap.json` (the setup token only, 0600) or from `CMS_SETUP_TOKEN`.

`--site-url https://www.example.com` sets `core.siteUrl` and the check URL when the site has a custom domain; otherwise the workers.dev URL is used and `core.siteUrl` is set to it only if it was unset. A plugin's required setting that is empty stops the deploy before anything changes (`SETTINGS_MISSING`).

# Day-to-day commands

**`cms rollback [version-id]`** sends 100% of traffic to an earlier version with the same call `cms deploy` uses to promote (`cf workers deployments create`). Without an id it picks the previous code: every secret change also creates a version and a deployment on Cloudflare, so deployments triggered by a secret change are skipped, and the target is the code deployment before the one that is live. Cloudflare keeps secrets per version, so a target that lacks secrets the live version has is refused before anything is asked (`SECRETS_DIFFER`, exit 4, naming them) — for an explicit id too; to go back to older code, check it out and run `cms deploy`. Rolling forward to a version with more secrets is fine. An id may be given in full or by its first 8+ characters (`cms version list`). The plan warns (`SCHEMA_AHEAD`) when migrations were recorded in `d1_migrations` after that version was uploaded: its code will run against the newer schema, and migrations are not rolled back. `--dry-run` and `--yes` work as in `deploy`; No exits 130.

**`cms domain list | add <host> | remove <host>`** edit `routes` in `wrangler.jsonc` (`{ "pattern": "<host>", "custom_domain": true }`, comments kept) and nothing else. Cloudflare attaches the domain at the next `cms deploy`. `core.siteUrl` is never changed here: when a new domain becomes the main address, change it in admin → Settings (`cms deploy` only sets it while it is empty). Without `"workers_dev": true`, declaring routes turns the workers.dev address off; `add` warns. A removed domain may stay attached after the next deploy; detach it in the dashboard if so. Removing the last route removes the `routes` key too, so `add` followed by `remove` gives the file back unchanged.

**`cms secret list | set <NAME> | delete <NAME>`** go through `cf workers secrets`. A value comes from stdin (`printf %s "$VALUE" | cms secret set NAME`) or a hidden prompt; there is no flag for it, and no output contains it. Replacing or deleting asks first (`--yes` in CI). `SECRETS_KEY`, `AUTH_PEPPER` and `SETUP_TOKEN` are refused with exit 4 (`MANAGED_SECRET`): the first two can never change without breaking stored settings or every password, and `SETUP_TOKEN` is only ever generated when missing. While an uploaded version is not live (a deploy that did not finish), Cloudflare refuses every secret change (its code 10215); that is reported as `VERSION_NOT_LIVE` (exit 4) with `cms deploy` as the next step, here and in the managed-secrets step of `deploy`.

**`cms logs --since <15m|2h|3d>`** lists the Worker's errors (level `error`, or an invocation whose outcome is not `ok`) from Workers Logs through `cf o11y telemetry query --preview` (no saved query). Workers Logs keeps 7 days, so 7d is the limit; `--limit` caps the events (default 50). Observability must be on for the Worker (`"observability": { "enabled": true }` in `wrangler.jsonc`); when it is not, the output warns (`LOGS_NOT_ENABLED`) instead of reading as "no errors", and `cms doctor` lists it as a warning. The live tail works without it.

**`cms ci token`** prints the permissions of an account API token for this site, derived from the commands: Workers Scripts Write, D1 Write, Workers R2 Storage Write, Workers KV Storage Read (Write for destroy of a 1.x namespace), Account Settings Read, Workers Observability Read and Workers Tail Read; with custom domains also Workers Routes Write, DNS Write and Zone Read on those zones. It creates nothing: `cf accounts tokens create` describes its policy resources only as `{...}`, so the CLI does not build tokens.

**`cms ci init`** writes `.github/workflows/cms.yml`: a `workflow_dispatch` workflow that uses the same action versions as this repository's own CI (`actions/checkout@v7`, `pnpm/action-setup@v6` for pnpm projects, `actions/setup-node@v7`), installs the dependencies and `cf`, then runs `deploy --yes --json`, or `rollback [id] --yes --json`, with the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. An existing file is kept unless `--force`.

**`cms destroy`** deletes, in this order, the Worker (and with it its custom domains), the D1 database named by id in `wrangler.jsonc`, the R2 buckets named there, and KV namespaces whose ids are there. Nothing else on the account is touched. A bucket that still holds objects stops the whole command before anything is deleted (`BUCKET_NOT_EMPTY`, exit 4) — the page-cache bucket always does — unless `--purge-objects` is given: then the plan says how many objects each bucket holds ("at least 10000" when counting stops), and they are deleted in batches of 1000 (`cf r2 objects bulk-delete`, keys in a private body file) with a running count, right before their bucket. The site's own `WORKER_SELF_REFERENCE` binding makes the Worker reference itself, so it is deleted with `--delete-with-references`; a Worker that another Worker binds to is refused (`WORKER_REFERENCED`). In a terminal you type the Worker name; otherwise `--yes --confirm <worker-name>` is required (`--yes` alone exits 3). The plan suggests `wrangler d1 export` first. A failed delete reports what was already deleted.

# Plugins and upgrade

**`cms plugin list`** lists the code plugins compiled in (`extensions/registry.ts`) with their version, whether the registry (`--source`, read without a token) has a newer one — "registry: unknown" when it cannot be read or does not list the plugin — and whether required settings are still empty. It also lists the declarative plugins installed on the live site, read from the site database (`declarative_extensions`: id, version, enabled) with a read-only query; those are managed in the admin. Without a login or a deployed Worker the code plugins are still listed, with a warning that says why the rest is missing.

**`cms plugin configure <id>`** runs the settings interview of `plugin add` again in a terminal. Without one it reports the required settings that are empty as `INPUT_REQUIRED` with their names.

**`cms plugin remove <id>`** shows the plan (every file under `extensions/<id>/` and the `registry.ts` edit), asks, then deletes the files and removes the import and the array entry (the array stays on one line, the file's formatting contract). The plugin's tables, data and settings stay; the live site keeps it until the next `cms deploy`. An id that is not installed is refused with the nearest one suggested.

**`cms upgrade`** is read-only for now: how a site takes a new core is not decided yet. It reads the template's newest release tag (or its default branch, with a warning) with `git ls-remote` and a shallow clone into a temporary folder that is removed afterwards, and reports the site's core version, the newest one, whether the site is behind, and the migration files the newer core has that the site does not. No file changes.

# `cms init <dir>`

Clones the newest `x.y.z` release tag of the template (`git ls-remote --tags`); when there is none, the default branch, with a `NO_RELEASE_TAG` warning. `--ref` picks a branch or tag, `--template` (or `SZWS_CMS_TEMPLATE`) another repository, `--skip-git-init` keeps the template's history. `--deploy` continues with `cms deploy` in the new directory and names the site after it, so a directory name that cannot be a site name stops before cloning.

## Why not `JSON.parse` to edit `wrangler.jsonc`

The config file has inline comments on nearly every field. Those comments *are* the documentation. `JSON.parse` → modify → `JSON.stringify` strips all comments and reformats. So `cli/src/jsonc.ts` is a JSONC parser that tracks character offsets: edits replace only the literal value's byte range, leaving comments, indentation, trailing commas and key order unchanged. The edit range can only land on the tenant names, `database_id` and a missing `account_id`.

# `cms plugin add <id>`

Code-extension installer. Automates "fetch files from registry → write to `extensions/<id>/` → patch `extensions/registry.ts`"; DB row, build, and deploy remain manual (spec: `docs/spec-szws-cms-cli.md`).

## Usage

Run in the CMS repo root:

```bash
npx @sz.ws/cms plugin add <id>         # Direct run, no install needed
cms plugin add <id>                     # If globally installed
cms plugin add <id>@<x.y.z>             # A version the registry kept for older cores
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

## Output

Human-facing output — progress, steps, prompts, warnings, errors — goes to
**stderr**. stdout is reserved for results, so piping and redirecting behave:

```bash
cms deploy 2> deploy.log        # keep the transcript, stdout stays clean
cms add blog --json | jq .ok    # stdout is a single JSON object
```

| Goes to stdout | Everything else |
|---|---|
| `--version`, `--help` — the answer *is* the result | stderr |
| the result text of a command (a report, a URL) | stderr |
| `--json` — one envelope `{ ok, command, data, plan, warnings, error }`; `plugin add` keeps `{ ok, exitCode, command, id?, events?, messages[] }` | stderr |

Secret values entered during the `add` settings interview never appear in either
stream, nor in the `--json` transcript.

For `plugin add`, `--json` still writes the human transcript to stderr; `messages` is the flat transcript and `events` the settings interview.

## Develop

CLI has **no runtime dependencies**: `npx @sz.ws/cms` installs on-demand with fast cold startup, `pnpm test:cli` stays pure Node and completes in under 1 second. Terminal UI (`cli/src/ui.ts`) is hand-written, no prompt package like `@clack/prompts` — `cli/` is not a pnpm workspace member, so dependencies must be declared again in root `package.json` to install, and versions drift. 

All Cloudflare-touching commands use an **injected Executor** (`cli/src/exec.ts`); tests assert against a fake executor "what commands were sent", never touching real accounts.

CLI is pure Node (not in cloudflare workers test pool), source in `cli/src/`:

```bash
pnpm cli:build        # tsc -p cli/tsconfig.json → cli/dist/
pnpm cli:typecheck
pnpm test:cli         # vitest run --config vitest.cli.config.ts (node environment)
```

Published as `@sz.ws/cms`, with two bins: `cms` and the long alias `sz-ws-cms`.

Manual steps after CLI completes (CLI prints these): apply migrations (`pnpm db:migrate:local` / `:remote`), INSERT extensions row in admin's Installed tab, `pnpm build && wrangler deploy`.
