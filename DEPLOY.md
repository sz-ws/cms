# Deploying to your own Cloudflare account

Run these from the repository root in your own terminal. Assumes you have a
Cloudflare account and the project already runs locally (`pnpm dev` works).

```bash
# 0. install dependencies
pnpm install --frozen-lockfile

# 1. log in to Cloudflare
pnpm exec wrangler login

# 2. create the resources
pnpm exec wrangler d1 create cms-db          # note the database_id it prints
pnpm exec wrangler r2 bucket create cms-storage
pnpm exec wrangler r2 bucket create cms-next-cache

# 3. put that database_id into wrangler.jsonc, replacing the 00000000-… placeholder

# 4. set the production encryption key
#    Do NOT reuse the development value from .dev.vars.
openssl rand -base64 32                       # generate a fresh key
pnpm exec wrangler secret put SECRETS_KEY     # paste it in

# 5. run remote migrations and deploy
pnpm db:migrate:remote
pnpm deploy
```

## After deploying

Open the production URL and go to `/setup` to create the first admin account —
production D1 starts empty and shares nothing with your local database. Then
enable an extension under `/admin/extensions`, create an entry, and confirm the
public route renders it.

## Notes

- The project pins `pnpm@9.4.0`; `wrangler` stays on a 4.x release that runs on Node 20.
- `pnpm exec wrangler deploy --dry-run` gives you a Workers config and bundle preflight before the real deploy.
- Watch the worker size reported by `opennextjs-cloudflare build` — it should stay under 8 MB compressed.
