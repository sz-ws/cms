# @sz.ws/cms — `sz-cms add <id>`

sz.ws CMS 的 code-extension 安裝器。把「從 registry 抓檔 → 落地 `extensions/<id>/`
→ patch `extensions/registry.ts`」自動化;DB row、build、deploy 仍由人類執行
(spec:`docs/spec-szws-cms-cli.md`)。

## 使用

在 CMS repo 根目錄執行:

```bash
npx @sz.ws/cms add <id>                # 直接跑,免安裝
sz-cms add <id>                        # 已全域安裝時
```

| 旗標 | 說明 |
|---|---|
| `--source <url>` | registry base URL(預設 `https://raw.githubusercontent.com/sz-ws/registry/main`;支援 `file://` 本機測試) |
| `--token <t>` | private registry 的存取 token(亦讀環境變數 `SZWS_REGISTRY_TOKEN`;GitHub PAT / Gitea deploy token 皆可,送出為 `Authorization: token <t>`) |
| `--dry-run` | 只印出將做的事,不寫磁碟 / 不改檔 |
| `--force` | 覆寫已存在的 `extensions/<id>/`(registry.ts patch 天然 idempotent,不會重複插行) |
| `--non-interactive` | 不互動(隱含 `--force`);衝突仍中止 |
| `--skip-core-check` | 跳過 coreApi 相容性檢查(見下節)。squash 期間、或本機自行改過 `CORE_API_VERSION` 時的逃生門;不相容仍會警告 |

## Exit codes

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

CLI 是純 Node 程式(不進 cloudflare workers 測試池),原始碼在 `cli/src/`:

```bash
pnpm cli:build        # tsc -p cli/tsconfig.json → cli/dist/
pnpm cli:typecheck
pnpm test:cli         # vitest run --config vitest.cli.config.ts(node 環境)
```

發佈形狀:`@sz.ws/cms`,`bin: { "sz-cms": "./dist/cli.js" }`。**尚未 publish**
(2026-07-16 決議:只做套件形狀)。publish 前記得拿掉 `"private": true`。

CLI 完成後仍要人做的事(CLI 會印出):migrations(`pnpm db:migrate:local` /
`:remote`)、admin Installed 分頁 INSERT extensions row、`pnpm build && wrangler deploy`。
