# Cron companion worker

分鐘級準時排程的「錶」。這是一支**獨立部署**的 Cloudflare Worker 範本——它**不隨
CMS 一起部署**,而是單獨 `wrangler deploy`。它的唯一工作:依 cron 觸發,對 CMS 的
`POST /api/callback/cron:tick/cron` 送一個帶 HMAC-SHA256 簽章的請求,由 CMS 端的
`cron` extension(`cron:tick/cron` provider)驗簽後催動到期任務掃描。

## 為什麼需要它

CMS 與 core 同一個 worker,受 `@opennextjs/cloudflare` 無 `scheduled` handler 的限制,
無法自帶 cron。故「錶」活在外面:這支 worker 有 `scheduled` handler,CMS 端只提供
**驗簽入口**。

## 三步部署

1. **填 SITE_URL** —— 編輯 `wrangler.jsonc`,把 `vars.SITE_URL` 換成 CMS 站台 origin
   (無尾斜線),例如 `https://cms.example.com`。

2. **設 CRON_SECRET** —— 與 CMS admin settings 的「Cron signing secret」**同一個值**
   (兩端 HMAC 密鑰必須一致,否則簽章驗不過):

   ```sh
   wrangler secret put CRON_SECRET
   ```

3. **部署**:

   ```sh
   wrangler deploy
   ```

## 精度與保底

- **精度 = cron 間隔**:範本用 `["* * * * *"]`(每分鐘)。要更省可調成 `*/5 * * * *`。
- **lazy sweep 仍是保底**:core 本身在 admin 有人瀏覽時會 lazy 掃一次到期任務。這支
  worker 只是把準時度從「有人看時」提升到「每分鐘」。
- **worker 掛掉不會壞**:排程只是退回 core 的 lazy sweep 節奏(準時度下降),到期任務
  最終仍會被處理,資料不會壞。
