# 部署清單(Phase 7,在你自己的終端機執行)

前提:專案在 `/Users/kuosuko/Documents/suko-mod/cms/`,Phase 0-6 已完成並在本地驗收通過。

```bash
cd /Users/kuosuko/Documents/suko-mod/cms

# 0. 本機第一次跑:裝依賴
pnpm install --frozen-lockfile

# 1. 登入 Cloudflare
pnpm exec wrangler login

# 2. 建資源
pnpm exec wrangler d1 create cms-db          # 記下輸出的 database_id
pnpm exec wrangler r2 bucket create cms-storage
pnpm exec wrangler r2 bucket create cms-next-cache

# 3. 把 database_id 填進 wrangler.jsonc(取代 00000000-... 佔位)

# 4. 設 production 的加密金鑰(不要沿用 .dev.vars 裡的開發用值!)
openssl rand -base64 32                 # 產生新金鑰
pnpm exec wrangler secret put SECRETS_KEY     # 貼上剛才的值

# 5. 跑 remote migration + 部署
pnpm db:migrate:remote
pnpm deploy
```

部署後驗收(08 Phase 7):開 production URL → `/setup` 建 admin(production D1 是全新空庫,與本地資料無關)→ /admin/extensions 啟用 posts → 發一篇文 → `/posts` 公開頁可見。

備註:
- 本專案使用 `pnpm@9.4.0`;`wrangler` 固定在 Node 20 可執行的 4.x 版本
- 部署前可先跑 `pnpm exec wrangler deploy --dry-run` 做 Workers 設定與 bundle preflight
- bundle 預算:部署時留意 `opennextjs-cloudflare build` 輸出的 worker 大小,壓縮後應 < 8MB
