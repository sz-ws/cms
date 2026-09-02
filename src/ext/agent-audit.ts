import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
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

// ── 讀取 ────────────────────────────────────────────────────────────────────
// spec §1.3 的最後一句:「admin 可在面板查看」。這裡是那句話的資料層;頁面在
// src/app/(admin)/admin/agent/audit/。讀取只有這一種形狀 —— **最近 N 列 + 篩選**,
// 走 agent_audit_at_desc 索引。沒有「依 id 取單列」:稽核是拿來翻的,不是拿來
// 連結的;沒有 COUNT:一張只會長不會縮的表,總數這個數字每看一次都要掃全表,
// 而它回答不了任何「發生了什麼」的問題。

/** 篩選條件。全部可省略 = 最近 N 列。 */
export interface AgentAuditFilter {
  kind?: AgentToolKind;
  source?: AgentAuditSource;
  /** true = 只看成功;false = 只看失敗;省略 = 都看。 */
  ok?: boolean;
  /** 精確比對 tool 名稱(面板點某個 tool 進來看它的歷史)。 */
  tool?: string;
  /** keyset 游標:只取比它更早的列。來自上一頁的 `nextCursor`。 */
  cursor?: AgentAuditCursor;
  /** 每頁列數,預設 50,上限 200。 */
  limit?: number;
}

/**
 * keyset 游標。`at` 是 epoch ms,一毫秒內兩次 tool 執行並非不可能(loop 內連續
 * 兩個 read),所以第二個鍵 `id` 負責同毫秒內的順序 —— 沒有它,翻頁會在毫秒邊界
 * 漏列或重複。offset 分頁在這張表上不對:新列一直從頂端進來,offset 會漂。
 */
export interface AgentAuditCursor {
  at: number;
  id: string;
}

export interface AgentAuditRow {
  id: string;
  at: number;
  userId: string;
  userEmail: string;
  tool: string;
  kind: AgentToolKind;
  source: AgentAuditSource;
  args: string;
  ok: boolean;
  result: string | null;
  error: string | null;
}

export interface AgentAuditPage {
  rows: AgentAuditRow[];
  /** 還有更早的列時給下一頁的游標;沒有就是 null。 */
  nextCursor: AgentAuditCursor | null;
}

export const AGENT_AUDIT_PAGE_DEFAULT = 50;
export const AGENT_AUDIT_PAGE_MAX = 200;

/** URL 用的游標編碼:`<at>.<id>`。id 是 UUID(無「.」),故第一個「.」就是分界。 */
export function formatAuditCursor(cursor: AgentAuditCursor): string {
  return `${cursor.at}.${cursor.id}`;
}

/** 解不開就回 null(當作沒有游標),不 throw —— 這是從 URL 來的字串。 */
export function parseAuditCursor(raw: string | null | undefined): AgentAuditCursor | null {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;
  const at = Number(raw.slice(0, dot));
  const id = raw.slice(dot + 1);
  if (!Number.isSafeInteger(at) || at < 0 || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { at, id };
}

export async function listAgentAudit(
  filter: AgentAuditFilter = {},
): Promise<AgentAuditPage> {
  const limit = Math.min(
    AGENT_AUDIT_PAGE_MAX,
    Math.max(1, Math.floor(filter.limit ?? AGENT_AUDIT_PAGE_DEFAULT)),
  );
  const where: SQL[] = [];
  if (filter.kind) where.push(eq(agentAudit.kind, filter.kind));
  if (filter.source) where.push(eq(agentAudit.source, filter.source));
  if (filter.ok !== undefined) where.push(eq(agentAudit.ok, filter.ok ? 1 : 0));
  if (filter.tool) where.push(eq(agentAudit.tool, filter.tool));
  if (filter.cursor) {
    const { at, id } = filter.cursor;
    // (at, id) 嚴格小於游標 —— 同毫秒的列以 id 排序決定先後(見 AgentAuditCursor)。
    where.push(
      or(
        lt(agentAudit.at, at),
        and(eq(agentAudit.at, at), lt(agentAudit.id, id)),
      )!,
    );
  }

  // 多取一列判斷「還有沒有下一頁」,比多打一次 COUNT 便宜且不會漂。
  const rows = await db()
    .select()
    .from(agentAudit)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(agentAudit.at), desc(agentAudit.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit).map((r) => ({
    id: r.id,
    at: r.at,
    userId: r.userId,
    userEmail: r.userEmail,
    tool: r.tool,
    kind: r.kind,
    source: r.source,
    args: r.args,
    ok: r.ok === 1,
    result: r.result,
    error: r.error,
  }));
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: rows.length > limit && last ? { at: last.at, id: last.id } : null,
  };
}
