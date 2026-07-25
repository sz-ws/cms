# @sz-ws/cms — `cms` / `sz-ws-cms`

sz.ws CMS 的命令列工具,兩個指令:

| 指令 | 做什麼 |
|---|---|
| `sz-ws-cms setup` | 把 repo 接上你自己的 Cloudflare 帳號:建 D1 / R2、把 id 回填 `wrangler.jsonc`、套 migrations、設 `SECRETS_KEY` |
| `sz-ws-cms add <id>` | 安裝 code extension:從 registry 抓檔 → 落地 `extensions/<id>/` → patch `extensions/registry.ts` |

兩者都可以完全非互動執行(`--yes` / `--non-interactive`),也都有 `--dry-run`。

---

# `sz-ws-cms setup`

取代 `DEPLOY.md` 的手工流程。在 CMS repo 根目錄執行:

```bash
pnpm exec wrangler login    # 這一步仍然要自己來(CLI 不碰你的憑證)
npx @sz-ws/cms setup
```

| 旗標 | 說明 |
|---|---|
| `--config <path>` | wrangler 設定檔路徑(預設 `./wrangler.jsonc`) |
| `--dry-run` | 只偵測與列出計畫。**偵測指令照跑**(不跑的話印出來的計畫是編的),但一個資源都不建、一個檔都不改 |
| `--yes`, `-y` | 略過所有確認關卡(CI 用);`--non-interactive` 同義 |
| `--skip-migrations` | 不套用 `migrations/` |
| `--skip-secrets` | 不處理 `SECRETS_KEY`(收尾仍會提醒你補) |

## 它做了什麼

依 `wrangler.jsonc` 的 `d1_databases` / `r2_buckets` 逐項處理 —— 資源清單來自設定檔本身,
不寫死在 CLI 裡,所以之後增減 binding 不用改 CLI。

1. **登入檢查**(`wrangler whoami`)—— 沒登入就停在這裡,並告訴你跑什麼。
2. **盤點**:`wrangler d1 list --json` 比對名字、`wrangler r2 bucket info` 逐個確認。
3. **建缺的**:`wrangler d1 create` / `wrangler r2 bucket create`。
4. **回填 id** 到 `wrangler.jsonc`(見下節)。
5. **套 migrations**:只對**宣告了 `migrations_dir`** 的 D1 跑。`cms-tag-cache` 沒有那個欄位,
   它的 `revalidations` 表由 `opennextjs-cloudflare deploy` 的 populate-cache 自己建
   (schema 屬於 OpenNext,手抄一份進版控會漂移)。
6. **`SECRETS_KEY`**:已存在就跳過,**絕不覆寫**。要新設時由 CLI 產生 32 byte 隨機值,
   經 **stdin** 餵給 `wrangler secret put` —— 不進 argv(會被 `ps` 看到)、不留在 shell history、
   不印在畫面上、本機不留副本。

## 冪等 / 跑到一半斷掉

每一步都先「看帳號上有什麼」再決定要不要動作,而不是記錄自己做過什麼。所以**直接重跑就好**:

- D1 用**名字**去 `d1 list` 找,找到就沿用既有 uuid —— 不會建出第二個。
- R2 先 `bucket info`;真的建到已存在的 bucket,`already exists` 也被當成成功。
- `wrangler.jsonc` 的值已經正確就完全不產生編輯(檔案 mtime 都不動)。
- migrations 本來就有 applied 紀錄,重跑是 no-op。
- 中途失敗時,**已經拿到的 id 仍會先寫回設定檔** —— 否則使用者會以為什麼都沒成功。

## 為什麼不用 `JSON.parse` 改 `wrangler.jsonc`

那份設定檔幾乎每個欄位上面都壓著一段註解(為什麼 `main` 指向 `custom-worker.ts`、
為什麼有第二個 `database_id` 佔位值……),註解就是它的文件本體。
`JSON.parse` → 改 → `JSON.stringify` 會把註解全部吃掉並重排版面。

所以 `cli/src/jsonc.ts` 是一個會記錄**字元位移**的 JSONC parser:要改某個值時只替換
「那個值的字面量」所佔的區間,其餘 byte 一個都不動 —— 註解、縮排、尾逗號、鍵的順序全部原樣保留。

副作用是安全性:編輯區間結構上只可能落在 `d1_databases[].database_id` 上,
`main` / `triggers` / `assets` / `services` **改不到**。寫入前還會重讀一次檔案再重算位移,
避免與其他正在改同一份設定檔的人打架。

## Exit codes(setup)

| code | 意義 |
|---|---|
| 0 | 成功(含「全部都已就緒、什麼都不用做」) |
| 7 | 前置條件不足:未登入、讀不到 / 解析不了設定檔、`d1 list` 查不到 |
| 8 | 某個 wrangler 操作失敗(建資源 / migrations / 寫檔) |
| 9 | 使用者在確認關卡選擇中止(零副作用) |

`d1 list` 查不到時刻意**不硬做** —— 沒有那份清單就無法判斷哪些資源已存在,
硬建下去可能產生重複的資料庫。

## 它不做的事

`wrangler login`(碰憑證)、`pnpm run deploy`、開 `/setup` 建第一個管理員、設 `core.siteUrl`。
這些會列在收尾訊息裡,由人執行。

---

# `sz-ws-cms add <id>`

code-extension 安裝器。把「從 registry 抓檔 → 落地 `extensions/<id>/`
→ patch `extensions/registry.ts`」自動化;DB row、build、deploy 仍由人類執行
(spec:`docs/spec-szws-cms-cli.md`)。

## 使用

在 CMS repo 根目錄執行:

```bash
npx @sz-ws/cms add <id>                # 直接跑,免安裝
sz-ws-cms add <id>                        # 已全域安裝時
```

| 旗標 | 說明 |
|---|---|
| `--source <url>` | registry base URL(預設 `https://raw.githubusercontent.com/sz-ws/registry/main`;支援 `file://` 本機測試) |
| `--token <t>` | private registry 的存取 token(亦讀環境變數 `SZWS_REGISTRY_TOKEN`;GitHub PAT / Gitea deploy token 皆可,送出為 `Authorization: token <t>`) |
| `--dry-run` | 只印出將做的事,不寫磁碟 / 不改檔 |
| `--force` | 覆寫已存在的 `extensions/<id>/`(registry.ts patch 天然 idempotent,不會重複插行) |
| `--non-interactive` | 不互動(隱含 `--force`);衝突仍中止 |
| `--skip-core-check` | 跳過 coreApi 相容性檢查(見下節)。squash 期間、或本機自行改過 `CORE_API_VERSION` 時的逃生門;不相容仍會警告 |

## Exit codes(add)

| code | 意義 |
|---|---|
| 0 | 成功(含 declarative id 的指路提示、idempotent 再跑) |
| 1 | 找不到 `<id>` / 無效 id / 多源衝突 |
| 2 | 抓檔失敗(網路、404、size cap、401 缺 token) |
| 3 | `extensions/<id>/` 已存在且無 `--force` |
| 4 | `extensions/registry.ts` patch 失敗(不在 CMS repo 根目錄 / 格式辨識不出來) |
| 5 | 未知錯誤 |
| 6 | extension 的 `coreApi` 不相容本機 core(見下節;`--skip-core-check` 可繞過) |

## coreApi 相容性檢查

registry index entry 的 `coreApi` 是一段 semver range(`^1.5.0` 之類)。安裝前 CLI 會
用 regex 從本機 `src/ext/version.ts` 撈 `CORE_API_VERSION`,以 `src/ext/semver.ts`
的同一套語意(`1.2.3` / `^1.2.3` / `~1.2.3` / `>=1.2.3`)判定:

| 情況 | 行為 |
|---|---|
| 相容 | 照常安裝(`--dry-run` 會印出判定結果) |
| 不相容 | **exit 6**,不落地任何檔案、不動 `registry.ts`;訊息列出需求 / 現況 / 三條出路 |
| range 形式解析不了(`>1.0.0`、`1.x`…) | 視為不相容(fail closed,與 core 相同)+ 說明支援哪些形式 |
| 讀不到本機 `CORE_API_VERSION` | 只警告、繼續安裝(CLI 缺資訊 ≠ 使用者有錯;Enable 那步仍有 core 把關) |

不擋的話,不相容的 extension 會一路裝完 → rebuild → deploy,直到 admin 按 Enable 才被
`enableExtension()` 的 `CoreApiIncompatible` 擋下 —— 失敗點離錯誤來源太遠。

> CLI 是獨立編譯的純 node 程式,**不 import `src/`**(會拖進整個 Next module graph),
> 所以版號用文字撈、semver 判定在 `cli/src/coreapi.ts` 重抄一份。
> **`src/ext/semver.ts` 的語意若改動,`cli/src/coreapi.ts` 必須同步**,否則 CLI 放行的
> extension 到 Enable 那步仍會被擋。

## 檔案清單:files[] vs 啟發式

registry index entry 有 `files: string[]` 時,那份清單是權威的,CLI 照抓(支援子目錄)。
沒有時退回**啟發式**:probe 一組固定的扁平檔名。這個模式有已知缺口 —— 它**不會進子目錄**
(例:`cron` 的 `worker/` 三個檔抓不到),所以 CLI 會明確警告清單是猜的、可能不完整。
啟發式 probe 只把 404 當成「該檔不存在」;逾時 / 401 / size cap 等錯誤一律中止(exit 2),
不靜默少抓檔。長期解法是 registry 每個 code entry 都補上 `files[]`。

## 開發

CLI 刻意**零依賴**:`npx @sz-ws/cms` 免安裝、冷啟動快,`pnpm test:cli` 保持純 node 且跑在 1 秒內。
終端 UI(`cli/src/ui.ts`)因此是手寫的,沒有引入 `@clack/prompts` 之類的 prompt 套件 ——
`cli/` 也不是 pnpm workspace 成員,依賴得在根 `package.json` 再宣告一次才裝得到,兩邊版本會漂移。

所有會動到 Cloudflare 的指令都走**可注入的 Executor**(`cli/src/exec.ts`),
測試一律對假 executor 斷言「送出了哪些指令」,不會碰到任何真實帳號。

CLI 是純 Node 程式(不進 cloudflare workers 測試池),原始碼在 `cli/src/`:

```bash
pnpm cli:build        # tsc -p cli/tsconfig.json → cli/dist/
pnpm cli:typecheck
pnpm test:cli         # vitest run --config vitest.cli.config.ts(node 環境)
```

發佈形狀:`@sz-ws/cms`,`bin: { "sz-ws-cms": "./dist/cli.js" }`。**尚未 publish**
(2026-07-16 決議:只做套件形狀)。publish 前記得拿掉 `"private": true`。

CLI 完成後仍要人做的事(CLI 會印出):migrations(`pnpm db:migrate:local` /
`:remote`)、admin Installed 分頁 INSERT extensions row、`pnpm build && wrangler deploy`。
