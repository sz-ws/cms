import { db } from "@/lib/db";
import { aiUsage } from "@/lib/schema";
import { getSetting } from "@/lib/settings";
import type { SessionUser } from "@/lib/auth";
import type { AiChatUsage } from "./providers/ai";

// AI token 用量的寫入端(migrations/0017_ai_usage.sql,CORE_API 1.34.0)。
//
// 契約完全照 ./agent-audit.ts 的先例,兩條都是刻意的:
//   * **append-only** —— 本檔只有 INSERT,不提供任何 update/delete。
//   * **fail-open** —— 記不成功只 console.error,絕不 throw。一次記不下來的用量
//     不值得讓一輪已經跑完的對話在使用者眼前變成錯誤;失敗會留在 log 裡(表不
//     存在 = migration 沒套用,那是部署問題,本來就該在 log 看得到)。
//
// ── **絕不記下 prompt 或回覆的內容,只記數字** ──────────────────────────────
//
// 這是本檔唯一不可協商的規則,寫在最前面是因為它最容易在「多存一點事後好查」的
// 名義下被侵蝕。usage 紀錄回答的是「多少」:誰、什麼時候、打了哪一家哪個模型、
// 幾個 token、成不成功。它**不**回答「說了什麼」——那是 agent_audit 在管的問題
// (且受它自己的截斷與 secret 規則約束)。一張會長大的計費表如果順手夾帶對話
// 內容,它就同時是一份沒有人在看的對話備份;而備份的保存期限與計費資料完全不同。
//
// 唯一的文字欄是 error,存的是上游錯誤摘要(截 200 字,同 ai:generate 的既有慣例
// ——絕不含 apiKey,呼叫端在組錯誤字串時就保證了這件事)。
//
// ── 為什麼失敗的呼叫也要一列 ────────────────────────────────────────────────
//
// 一次逾時或 4xx 一樣可能被上游計費(逾時尤其:對面已經生成了,只是我們沒等到)。
// 而且「打了一次但不知道用了多少」與「沒打」必須分得出來 —— 所以拿不到 usage 時
// 仍然寫一列,兩個 token 欄位是 NULL。**NULL 不是 0**(見 migration 檔頭)。

/** 錯誤摘要上限。同 ai:generate / agent_audit 的 200 字慣例。 */
export const AI_USAGE_ERROR_MAX = 200;

/** agent loop 的呼叫來源標籤。feature 是自由字串(見 schema.ts),但 core 自己
 *  用到的值要有一個常數 —— 打錯一個字的後果是那些列從此聚合不到一起,而且不會
 *  有任何錯誤訊息。 */
export const AI_USAGE_FEATURE_AGENT_CHAT = "agent.chat";

export interface AiUsageEntry {
  /** who。只取 id 與 email —— 同 agent_audit,要的是「誰」不是整個 session 物件。 */
  actor: Pick<SessionUser, "id" | "email">;
  /** 呼叫來源,如 "agent.chat"。 */
  feature: string;
  /** 上游回報的實際 model;拿不到就留白(失敗的呼叫通常沒有)。 */
  model?: string;
  /** 上游回報的 token 數。**缺席時兩個欄位都寫 NULL,不補 0**。 */
  usage?: AiChatUsage;
  /** 這一次上游呼叫成功與否。 */
  ok: boolean;
  /** 失敗原因摘要(會再截一次 200 字)。 */
  error?: string;
}

function truncate(raw: string, max: number): string {
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

/**
 * 這一列用的是哪一種 mode。
 *
 * 從設定讀而不是由呼叫端傳:mode 是 CoreAiProvider 唯一的路由依據
 * (src/ext/providers/ai.ts 的 chat / chatStream),而 AiChatResult 只帶回 model
 * 不帶 mode。getSetting 有 per-request cache + module memo(src/lib/settings.ts),
 * 所以這裡讀到的就是**同一個請求裡剛剛用來路由的那個值**,不是第二次 DB 往返。
 *
 * 已知的縫:admin 在一次呼叫進行中改了 core.ai.mode,這一列會標上新值。窗口是
 * 單次呼叫的長度,而代價是一列標錯 —— 比起讓這一欄永遠是 NULL(那才是真的沒有
 * 資訊),這個取捨划算。
 *
 * 自己 try/catch:設定讀不到不該讓整列消失 —— 沒有 mode 的用量仍然是用量。
 */
async function resolveMode(): Promise<string | null> {
  try {
    return (await getSetting<string>("core.ai.mode", "")) || null;
  } catch (e) {
    console.error("[ai-usage] cannot resolve core.ai.mode", e);
    return null;
  }
}

/**
 * 寫一列用量紀錄。**append-only**、**fail-open**(見檔頭)。
 *
 * 呼叫時機是「一次上游呼叫剛結束」——成功與失敗都呼叫一次,而且**一次呼叫一列**
 * (agent loop 的每一步各一列,不合併)。
 */
export async function recordAiUsage(entry: AiUsageEntry): Promise<void> {
  try {
    const mode = await resolveMode();
    await db()
      .insert(aiUsage)
      .values({
        id: crypto.randomUUID(),
        at: Date.now(),
        feature: entry.feature,
        mode,
        model: entry.model ?? null,
        // ?? null 不是 ?? 0:上游沒回報就是不知道(見檔頭與 migration)。
        inputTokens: entry.usage?.inputTokens ?? null,
        outputTokens: entry.usage?.outputTokens ?? null,
        userId: entry.actor.id,
        userEmail: entry.actor.email,
        ok: entry.ok ? 1 : 0,
        error: entry.ok
          ? null
          : truncate(entry.error ?? "unknown_error", AI_USAGE_ERROR_MAX),
      });
  } catch (e) {
    console.error(`[ai-usage] failed to record "${entry.feature}"`, e);
  }
}
