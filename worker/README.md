# worker/ — 選用的「啟動時建好 Next 伺服器」入口

## 這是什麼

一個可以換上的 Worker 入口。它跟預設的 `custom-worker.ts` 是同一個 Worker,回應的內容一樣;差別只在
Next 伺服器什麼時候建:預設是第一個請求進來時才建,這個入口改成 isolate 一啟動就建好。

| 檔案 | 用途 |
|---|---|
| `eager-entry.ts` | 入口本身。先載入 `custom-worker`,再載入 `eager-startup.mjs`,然後原樣轉出 custom-worker 的所有匯出 |
| `eager-startup.mjs` | 換掉 `fetch` 與 `Request`(照抄 OpenNext 的 `initRuntime`),然後在全域範圍載入 Next 伺服器 |
| `eager-startup.d.mts` | 只有 `export {}`。讓 tsc 停在 .mjs,不會把 16 MB 的 handler.mjs 載進型別檢查 |

cms 的預設入口仍是 `custom-worker.ts`,這個資料夾不開就不會被打包。

## 為什麼存在

OpenNext 在第一個請求裡才載入 Next 伺服器(`.open-next/worker.js` 在 `fetch` 裡 `await import` 它)。
冷的 isolate 上,不管打哪一條路由,第一個訪客都要等伺服器建好。這個入口把那段搬到啟動階段,不算進任何
一個請求。

本機 workerd、同一份建置量到的數字(2026-10-23,core 1.84.0):

- 冷的首頁 `/`:約 450 ms → 250–320 ms
- 熱請求:不變
- 啟動 CPU 約 250 ms(Cloudflare 的上限是 1 秒)

## 哪些站該開

訪客常打到冷 isolate 的站:流量不大、或常部署。要開的話,把 `wrangler.jsonc` 的 `main` 改成:

```jsonc
"main": "worker/eager-entry.ts",
```

要退回,改回 `"custom-worker.ts"` 就好。

代價是啟動變長。啟動超過 1 秒時,`wrangler deploy` 會直接失敗,線上照舊跑舊版本,不會有壞掉的版本上線。
所以開之前、以及升級 Next 或 OpenNext 之後,都先量一次。

## 怎麼量

先跑過 `opennextjs-cloudflare build`,再:

```bash
# 啟動時間:打包成一個檔,寫出啟動階段的 CPU profile(本機 CPU,只看相對變化)
pnpm exec wrangler deploy --dry-run --outfile x.bundle --compatibility-date 2026-05-03
pnpm exec wrangler check startup --worker x.bundle
```

```bash
# 第一個請求:每量一次都重開 wrangler dev,isolate 才是冷的
pnpm exec wrangler dev --port 8788 --compatibility-date 2026-05-03
curl -s -o /dev/null -w '%{time_total}\n' http://localhost:8788/
```

兩個入口各量幾輪再比。`x.bundle` 量完就刪,不要進版控。

## 升級 OpenNext 時

`eager-startup.mjs` 裡的替換照抄 @opennextjs/cloudflare 1.20.x 的 `.open-next/cloudflare/init.js`
裡的 `initRuntime`。每次升級都要打開新版的 init.js 對照一次:多換了什麼全域、或 handler.mjs 改成在最上層
就讀建置常數,這裡就要跟著改;拿不準就先把 `main` 改回 `custom-worker.ts`。

## 上游

如果 OpenNext 哪天自己在啟動時載入伺服器,這個資料夾就可以刪掉。
