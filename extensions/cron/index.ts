import { defineExtension } from "@/ext/types";
import { CronAdminPage } from "./admin-page";
import { CronTickProvider } from "./provider";

// cron code extension —— 分鐘級準時排程的「安全入口 + 設定 UX」。
//
// 定案:core 永遠只有 lazy sweep(零設定保底);分鐘級準時 = 這個 extension。
// 它跟 core 同一個 worker,同樣受 @opennextjs/cloudflare 無 `scheduled` handler 的
// 限制,故不自帶定時器 —— 錶活在外面(見 worker/ 範本),extension 提供的是驗簽入口
// (provides: cron:tick/cron)+ 一個加密的 signing secret setting。
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
      title: "Cron",
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
