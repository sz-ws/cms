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

## Exit codes

| code | 意義 |
|---|---|
| 0 | 成功(含 declarative id 的指路提示、idempotent 再跑) |
| 1 | 找不到 `<id>` / 無效 id / 多源衝突 |
| 2 | 抓檔失敗(網路、404、size cap、401 缺 token) |
| 3 | `extensions/<id>/` 已存在且無 `--force` |
| 4 | `extensions/registry.ts` patch 失敗(不在 CMS repo 根目錄 / 格式辨識不出來) |
| 5 | 未知錯誤 |

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
