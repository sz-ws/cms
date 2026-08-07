import { db } from "@/lib/db";
import { agentAudit } from "@/lib/schema";
import type { SessionUser } from "@/lib/auth";
import type { AgentToolKind, AgentToolResult } from "./agent-tools";

// docs/spec-admin-agent.md §1.3(安全模型第三條,不可協商):
// 「每次 tool 執行(read 與 write 都記)寫入 agent_audit 表:who(userId/email)、
//  tool、args(JSON)、result 摘要、成功與否、時間。」
//
// 這支函式住 kit 層而不是 route 層,理由與 invokeAgentTool 相同:兩個端點
// (/chat 內自動執行的 read、/execute 由人確認後執行的 write)必須寫出**同一種**
// 紀錄。各寫各的,遲早會有一邊少記一個欄位,而少記的那一邊一定是比較少被看的
// 那一邊。
//
// ── 記的是「執行」,不是「LLM 說了什麼」──────────────────────────────────────
// LLM 提案了一個 write 但 admin 還沒按確認 —— 那不是執行,不記執行列(spec §4:
// write tool 在 loop 內永不執行)。agent_audit 回答的是「站上實際發生了什麼」,
// 把提案混進去會讓這張表變成「AI 想做什麼」的紀錄,兩件事的稽核價值完全不同。
//
// ── secret ──────────────────────────────────────────────────────────────────
// secret 類 setting 的值結構上進不來:core.settings.get 從不讀 secret 欄位
// (agent-tools-core.ts 的 readSettingsSafely,「從未取得明文」而非「事後遮罩」)。
// 因此本檔不做遮罩 —— 遮罩要成立得倚賴每一處都不出錯,而這裡沒有東西需要遮。
// 截斷仍照做,但那是為了控制表的大小,不是為了保密。

/** 這一列是哪條路徑產生的。spec §4 的兩個端點各對應一個值。 */
export type AgentAuditSource = "chat" | "execute";

/** args 摘要上限。夠看清「動的是哪一筆」,又不會讓一次大 payload 撐大整張表。 */
export const AGENT_AUDIT_ARGS_MAX = 2_000;
/** result 摘要上限。這一欄是「摘要」不是「結果」—— 完整結果不該住稽核表。 */
export const AGENT_AUDIT_RESULT_MAX = 1_000;
/** 錯誤摘要上限。同 ai:generate 的 200 字慣例。 */
export const AGENT_AUDIT_ERROR_MAX = 200;

export interface AgentAuditEntry {
  /** who。只取 id 與 email —— 稽核要的是「誰」,不是整個 session 物件。 */
  actor: Pick<SessionUser, "id" | "email">;
  toolName: string;
  kind: AgentToolKind;
  source: AgentAuditSource;
  /** 已驗證前的原始 args(驗不過也要記:那也是一次嘗試)。 */
  args: unknown;
  /** invokeAgentTool 的結果,成功與失敗都收。 */
  outcome: AgentToolResult;
}

function truncate(raw: string, max: number): string {
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

/**
 * 任意值 → 截斷後的 JSON 文字。
 *
 * stringify 失敗(循環參照、BigInt、含 toJSON 例外的物件)不讓整次稽核寫入跟著
 * 失敗 —— 記下「有這麼一次執行、但結果無法序列化」仍然比沒有紀錄好。
 */
function jsonSummary(value: unknown, max: number): string {
  let raw: string;
  try {
    raw = JSON.stringify(value ?? null) ?? "null";
  } catch {
    raw = "[unserializable]";
  }
  return truncate(raw, max);
}

/** 失敗原因摘要。invalid_args 一定要帶上 issues,否則「invalid_args」這五個字
 *  在事後查不出任何東西。 */
function errorSummary(outcome: Extract<AgentToolResult, { ok: false }>): string {
  const detail = outcome.issues?.length
    ? `${outcome.error}: ${outcome.issues.join("; ")}`
    : outcome.error;
  return truncate(detail, AGENT_AUDIT_ERROR_MAX);
}

/**
 * 寫一列稽核紀錄。**append-only**:本檔不提供任何 update/delete。
 *
 * best-effort(失敗只 console.error,不 throw):呼叫端已經執行完了 —— 對一個
 * 已經寫進 DB 的 write 而言,這裡再 throw 只會讓 admin 看到一個錯誤訊息,而動作
 * 其實已經發生,那是比「稽核少一列」更糟的假象。失敗會留在 log 裡(表不存在 =
 * migration 沒套用,那是部署問題,應該在 log 就看得到)。
 */
export async function recordAgentToolRun(entry: AgentAuditEntry): Promise<void> {
  const { outcome } = entry;
  try {
    await db()
      .insert(agentAudit)
      .values({
        id: crypto.randomUUID(),
        at: Date.now(),
        userId: entry.actor.id,
        userEmail: entry.actor.email,
        tool: entry.toolName,
        kind: entry.kind,
        source: entry.source,
        args: jsonSummary(entry.args, AGENT_AUDIT_ARGS_MAX),
        ok: outcome.ok ? 1 : 0,
        result: outcome.ok
          ? jsonSummary(outcome.result, AGENT_AUDIT_RESULT_MAX)
          : null,
        error: outcome.ok ? null : errorSummary(outcome),
      });
  } catch (e) {
    console.error(`[agent-audit] failed to record "${entry.toolName}"`, e);
  }
}
