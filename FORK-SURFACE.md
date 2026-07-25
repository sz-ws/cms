# Fork surface — 客戶站可以改哪些檔

這個 repo 是 **scaffold**:每個站台是 clone 出去再改的。而「改了哪些檔」直接決定
日後能不能把上游的修正 merge 回已交付的站 —— merge 只有在雙方改的是**不同檔案**時
才會順利。

所以分歧要刻意維持得很小。這份文件就是那條界線。

## 一句話的升級流程

```bash
git remote add upstream <canonical-repo-url>   # clone 當下就設,永不刪除
git fetch upstream && git merge upstream/main  # 之後每次要拿上游修正
pnpm db:migrate:remote && pnpm run deploy
```

沒有 `upstream` 這個遠端,就沒有升級路徑 —— 事後補共同歷史可行但很煩。**clone 站台的
第一件事就是加它。**

## 界線

程式碼裡有三種可 grep 的標記,語意如下:

| 標記 | 意思 |
|---|---|
| `[core] 不要在客戶站改這個檔` | 上游會改它。你也改 = 每次升級都在同一處衝突 |
| `[site] 這個檔預期逐站不同` | 這裡是你的,改它不會跟上游打架 |
| `[site-seam] 這裡是接縫` | 給站台擴充用的掛點,優先用它而不是改 core |

```bash
grep -rn "\[site\]\|\[site-seam\]\|\[core\] 不要" src/ extensions/ wrangler.jsonc
```

## 你的(改這些)

| 路徑 | 放什麼 |
|---|---|
| `src/app/site.css` | 品牌色、字體、樣式覆寫。在 `globals.css` 之後載入,所以蓋得掉 token 預設值 |
| `extensions/<你的站>/` | 這個站專屬的 extension。多數客製都該落在這裡 |
| `extensions/registry.ts` | 加一行 import + 陣列項。⚠️ `export const registry` 那行的排版是 CLI 的契約,不要換行 |
| `wrangler.jsonc` | worker 名稱、D1/R2 的 id(`sz-ws-cms setup` 會自動填)。但 `main` 與 `triggers` 是 core 的 |
| `public/brand/` | logo、favicon 等品牌資產 |
| `src/app/(public)/icon.svg` | 公開站的 favicon。`(admin)/` 底下那份是後台用的產品 icon,別動 |

## 不是你的(別改這些)

| 路徑 | 需求要放哪裡 |
|---|---|
| `src/app/layout.tsx` | 站名/描述 → settings(`core.siteTitle`);樣式 → `site.css` |
| `src/app/globals.css` | → `site.css`。⚠️ 它的 `@source` 指令刪掉會讓每頁 500 |
| `src/app/(public)/layout.tsx` | 頁首頁尾 → 在你的 extension 註冊 `filter:publicHeader` / `filter:publicFooter` |
| `src/lib/`、`src/ext/`、`src/components/` | 整個 core。要改行為就開 extension |
| `migrations/` | 你的表 → 走 extension 的 migration,不要往這個共用序列加號 |

## 為什麼值得守

不守的話,第五個客戶站上線時你在維護五份分岔的 core。上游修了一個 XSS,你要手動
backport 五次 —— 而且**你不會知道哪幾個站已經拿到了**。

守住的話,升級是一個指令。

## 檢查

```bash
git diff upstream/main...HEAD --stat
```

理想結果只有上面「你的」那張表裡的檔案。出現別的,就是分歧開始長出來了 —— 現在處理
比之後便宜。
