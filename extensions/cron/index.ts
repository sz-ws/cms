import { defineExtension } from "@/ext/types";
import { CronAdminPage } from "./admin-page";
import { CronTickProvider } from "./provider";

// cron code extension —— 分鐘級準時排程的「安全入口 + 設定 UX」。
//
// 定案(不變):core 永遠只有 lazy sweep(零設定保底);分鐘級準時 = 這個 extension。
// signing secret 與驗簽入口(provides: cron:tick/cron)都住在這裡,core 不持有任何
// cron 密鑰。
//
// 錶(定時器)現在**內建**:wrangler.jsonc 的 `triggers.crons` → custom-worker.ts 的
// `scheduled` handler → scheduled.ts 讀出本 extension 的 secret 簽章後回呼
// `POST /api/callback/cron:tick/cron`。@opennextjs/cloudflare 的產出物仍然沒有
// `scheduled`,但它的 CLI 不碰 wrangler 的 `main`,所以 custom-worker.ts 可以原樣
// 再包一層(詳見 src/lib/jobs.ts header)。worker/ 下的 companion worker 範本改為
// 「外部排程器」的備選方案,不再是唯一路徑。
//
// coreApi "^1.0.0":只用 provides(core-v2 §2.2)與 adminPages/settings(03 §6a,
// 皆自 1.0.0 即在),對現行 CORE_API_VERSION(1.9.0)以 caret 相容(同 major)。

export const cron = defineExtension({
  id: "cron",
  name: "Cron",
  version: "1.0.0",
  coreApi: "^1.0.0",
  description:
    "分鐘級準時排程入口:外部 companion worker 以簽章回呼催動 core 的到期任務掃描。",
  icon: "clock",
  settings: [
    {
      key: "secret",
      label: "Cron signing secret",
      type: "text",
      secret: true, // → ext.cron.secret,自動走 AES-GCM 加密管線。
      default: "",
    },
  ],
  // 裝完的「下一步」引導 + tick 觀測(sidebar 進 /admin/ext/cron)。
  adminPages: [
    {
      slug: "",
      title: { en: "Cron", "zh-Hant": "排程" },
      component: CronAdminPage,
    },
  ],
  provides: [
    {
      capability: "cron:tick",
      id: "cron",
      create: (services) => new CronTickProvider(services),
    },
  ],
});
