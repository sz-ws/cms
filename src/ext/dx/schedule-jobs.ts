import { and, eq, lt } from "drizzle-orm";
import { contents } from "@/lib/schema";
import { deleteSubmissionRecord } from "@/lib/submissions";
import type { ContentProvider } from "../capabilities";
import type { ExtJobRegistration } from "../types";
import type { DeclarativeContentType, DeclarativeManifest } from "./manifest";

// B(docs/spec-declarative-notify-schedule.md):manifest 頂層 `schedule[]` →
// Extension.jobs 的建構邏輯。獨立成不依賴 views 的純模組 —— interpret.tsx 經
// ./views/DetailView 拉進 next/navigation,測試靜態 import interpret.tsx 會炸
// workers pool(同 dashboard-cards.ts 把邏輯抽出、單獨可測的決策)。
//
// 本檔僅 `import type { ExtJobRegistration } from "../types"`:types.ts 對
// CoreServices/SessionUser 也僅 import type(編譯期即消除),故連 types.ts 本身
// 都對 workers pool 安全 —— 這裡额外用 type-only import 更是零風險。

/** deleteOlderThan 每輪刪除上限(bound sub-request 數;剩的下輪撿,見 run() 內註解)。 */
const DELETE_OLDER_THAN_LIMIT = 50;
const MS_PER_DAY = 86_400_000;

/**
 * 把 manifest.schedule[] 轉為 Extension.jobs(ExtJobRegistration[])。指向不存在
 * contentType 的項目軟跳過(同 adminPages 慣例,manifest 不做 zod 交叉檢查)。
 * v1 僅一個 op:deleteOlderThan。
 */
export function buildScheduleJobs(
  extId: string,
  manifest: DeclarativeManifest,
  types: Map<string, DeclarativeContentType>,
): ExtJobRegistration[] {
  const jobs: ExtJobRegistration[] = [];
  for (const item of manifest.schedule ?? []) {
    const ct = types.get(item.action.contentType);
    if (!ct) continue; // 指向不存在的 type:跳過。
    const fullType = `${extId}.${ct.name}`;
    const days = item.action.days;

    jobs.push({
      id: item.id,
      every: item.every,
      run: async (services, _payload, now) => {
        const cutoff = now - days * MS_PER_DAY;
        // LIMIT 50:bound 每輪 sub-request 數;超過的老列留給下一輪 sweep 續撿
        // (recurring job 不重試不補跑,但下次到期會重新選出仍逾期的列)。
        const due = await services.db
          .select({ id: contents.id })
          .from(contents)
          .where(and(eq(contents.type, fullType), lt(contents.createdAt, cutoff)))
          .limit(DELETE_OLDER_THAN_LIMIT);

        // 走 provider.delete(而非直接 DELETE FROM):保留 content:deleted hook /
        // FTS 清理 / cache 失效等既有副作用(CoreContentProvider.delete 現況)。
        const provider = services.providers.get<ContentProvider>("content");
        for (const row of due) {
          await provider.delete(fullType, row.id);
          // 收件紀錄一併清掉(這條路徑正是 contact 的 180 天清理所走的)。側表已宣告
          // ON DELETE CASCADE,但 D1 是否開啟 FK enforcement 不在本層掌控內 ——
          // 同 revisions 的既有處理,明確再刪一次。非 submission 的型別沒有側表列,
          // 這一刪影響 0 列,不需要在此判斷型別。
          await deleteSubmissionRecord(row.id);
        }
      },
    });
  }
  return jobs;
}
