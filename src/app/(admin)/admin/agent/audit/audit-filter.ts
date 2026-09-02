import {
  parseAuditCursor,
  type AgentAuditFilter,
} from "@/ext/agent-audit";

// URL search params ↔ listAgentAudit 的篩選。純函式,獨立成檔是為了可測:
// 這是整頁唯一會把「使用者可控的字串」翻成查詢條件的地方。
//
// 篩選住在 URL 而不是元件狀態(rules/web/patterns.md「URL as state」):
// 「只看失敗的寫入」這種畫面要能貼給別人、要能在瀏覽器上一頁回得來。
// 也因此沒有新的 API 端點 —— 翻頁與篩選都是換一個 URL 讓 server component
// 重查,少開一個要防的 admin-only 表面(同 /admin/agent 對 tool 清單的取捨)。

export type AuditView = "all" | "read" | "write" | "failed";

export type SearchParams = Record<string, string | string[] | undefined>;

export interface AuditQuery {
  view: AuditView;
  tool: string | null;
  filter: AgentAuditFilter;
}

function first(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.length > 0 ? s : null;
}

/** tool 名稱與 registry 的命名規則同步(src/ext/agent-tools.ts AGENT_TOOL_NAME_RE)。
 *  對不上就當沒有:URL 裡的任意字串不該原樣進 SQL 參數,即使 drizzle 會綁參數。 */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export function readAuditQuery(sp: SearchParams): AuditQuery {
  const rawView = first(sp.view);
  const view: AuditView =
    rawView === "read" || rawView === "write" || rawView === "failed"
      ? rawView
      : "all";
  const rawTool = first(sp.tool);
  const tool = rawTool && TOOL_NAME_RE.test(rawTool) ? rawTool : null;
  const cursor = parseAuditCursor(first(sp.before));

  const filter: AgentAuditFilter = {};
  if (view === "read" || view === "write") filter.kind = view;
  if (view === "failed") filter.ok = false;
  if (tool) filter.tool = tool;
  if (cursor) filter.cursor = cursor;

  return { view, tool, filter };
}

/** 反向:給連結用。省略 cursor = 回第一頁(換篩選時一定要回第一頁,舊游標對新
 *  篩選沒有意義)。 */
export function auditHref(
  q: { view: AuditView; tool: string | null },
  before?: string,
): string {
  const p = new URLSearchParams();
  if (q.view !== "all") p.set("view", q.view);
  if (q.tool) p.set("tool", q.tool);
  if (before) p.set("before", before);
  const qs = p.toString();
  return qs ? `/admin/agent/audit?${qs}` : "/admin/agent/audit";
}
