// [site] 這個檔預期逐站不同 —— 每個站裝的 extension 不一樣,改它是正常的。
//
// 但它也是**上游會動的檔**(core 更新預設 bundle 時),所以是最可能衝突的地方。
// 衝突了就手動把兩邊的 import 與陣列項都留下,語意上永遠是聯集。
//
// ⚠️ 最下面 `export const registry` 那一行的排版是 CLI 的公開契約
//(cli/src/patch.ts 用 regex 錨定它)。不要換行、不要重排,否則 `sz-ws-cms add` 會裝不進去。
import type { Extension } from "@/ext/types";
import { cron } from "./cron";
import { newebpay } from "./newebpay";
import { sentry } from "./sentry";

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
//
// sentry 在預設陣列裡,理由和其他兩個不同:它裝著也完全不做事(DSN 空 = 零網路流量、
// 零成本),但**不**預先裝好的話,需要它的那一天通常就是出事的那一天 —— 而那時候
// 最不想做的事是「先 rebuild 一次再 deploy 才能開始看錯誤」。
export const registry: Extension[] = [cron, newebpay, sentry];
