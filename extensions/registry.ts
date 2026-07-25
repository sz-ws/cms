import type { Extension } from "@/ext/types";
import { cron } from "./cron";
import { newebpay } from "./newebpay";

// core-v2 §3.6 DEMO ONLY:progressive「程式碼強化層」的 side-effect import。
// 這行不加任何 Extension —— 它只在 bundle 載入時執行 gallery-enhance/index.ts,
// 於載入期把一個自訂 gallery detail 元件登記進 overrideRegistry。移除此行 = 移除
// override = 相關 surface 退回泛用 baseline(§3.6 back-compat)。真實強化層以相同方式
// 掛入。import 需在 registry 陣列建立前發生,故置於檔案頂部。
import "./gallery-enhance";

// Progressive custom-layout fixed entry: `extensions/blog/layout.tsx` ships a
// Notion-style editor Layout and self-registers for the declarative `blog`
// extension at module load. (docs/su-ext-cli-ideas.md §3)
import "./blog/layout";

// 03 §3:Registry。唯一需要「手動維護」的檔案。
// 安裝新 extension = 加一行 import + 加入陣列 + deploy。
// 陣列順序 = hook 執行順序 = 公開路由匹配優先序(先註冊先贏)。

/** 所有已「安裝」(編譯進 bundle)的 extensions */
// ai-smoke-test 刻意**不**在預設陣列裡:它是 ai:generate capability 的內部驗證用
// extension,不是產品功能。要試 AI capability 的人自己加一行 import 與陣列項。
export const registry: Extension[] = [cron, newebpay];
