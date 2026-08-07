import type { AgentToolKind } from "@/ext/agent-tools";

// docs/spec-admin-agent.md §5:斜線工具選單(GAIA Slash Command Dropdown 的角色)
// 背後的純邏輯。
//
// 清單來源是 **server component**(page.tsx 在 server 端從 buildAgentToolRegistry()
// 取出),不是新開的 API 端點 —— tool 清單隨已安裝的 extension 變動,但那個變動的
// 時機是「換頁」,不是「打字」。多開一支端點只是把一份 server 本來就握有的資料再
// 走一次網路,還多一個要防的 admin-only 表面。
//
// 比對/游標計算抽成純函式的理由與 transcript.ts 同:它們是「輸入什麼 → 應該看到
// 什麼」的規則,可以直接測,不必先渲染一個 textarea。

/** 傳給面板的 tool 摘要。刻意不帶 schema —— 前端不驗參數(驗證在 /execute)。 */
export interface AgentToolSummary {
  name: string;
  description: string;
  kind: AgentToolKind;
}

/** `content.gallery_item.list` → `content.gallery_item`(分組用)。 */
export function toolNamespace(name: string): string {
  const at = name.lastIndexOf(".");
  return at <= 0 ? name : name.slice(0, at);
}

/** `content.gallery_item.list` → `list`(動詞;清單上當主標)。 */
export function toolLeaf(name: string): string {
  const at = name.lastIndexOf(".");
  return at < 0 ? name : name.slice(at + 1);
}

/** description 的第一句 —— 作者寫給 LLM 看的第一句,對人也剛好是最短的說明。 */
export function toolBlurb(description: string): string {
  const first = description.split(". ")[0] ?? description;
  return first.trim().replace(/\.$/, "");
}

/**
 * 目前游標處是不是一個 `/` 起頭的 token。
 *
 * 判準刻意保守:`/` 必須在行首或緊接空白之後。否則使用者打一個網址或路徑
 * (`/admin/media`、`https://…`)就會被當成想選工具,而那個誤判會蓋住輸入框。
 */
export interface SlashQuery {
  /** token 在字串中的起點(含 `/`)。 */
  start: number;
  /** `/` 之後、游標之前的字。 */
  query: string;
}

export function readSlashQuery(text: string, caret: number): SlashQuery | null {
  const upto = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const match = /(^|\s)\/(\S*)$/.exec(upto);
  if (!match) return null;
  const query = match[2];
  return { start: upto.length - query.length - 1, query };
}

/** 選定一個 tool:把 `/query` 換成 tool 名 + 一個空白,游標落在空白之後。 */
export function applySlashSelection(
  text: string,
  slash: SlashQuery,
  caret: number,
  toolName: string,
): { text: string; caret: number } {
  const head = text.slice(0, slash.start);
  const tail = text.slice(caret);
  const inserted = `${toolName} `;
  return { text: `${head}${inserted}${tail}`, caret: head.length + inserted.length };
}

/**
 * 依 query 過濾與排序。
 *
 * 不做模糊比對:tool 名是結構化的點分識別字(`content.gallery_item.update`),
 * 使用者要嘛記得前綴要嘛記得動詞,模糊比對只會把不相干的東西排到前面。分數只
 * 表達「命中得多前面」,同分時以名字排序讓清單順序穩定。
 */
export function matchTools(
  tools: readonly AgentToolSummary[],
  query: string,
  limit = 12,
): AgentToolSummary[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...tools].sort(byName).slice(0, limit);

  const scored: { tool: AgentToolSummary; score: number }[] = [];
  for (const tool of tools) {
    const name = tool.name.toLowerCase();
    const leaf = toolLeaf(name);
    let score = -1;
    if (name.startsWith(q)) score = 0;
    else if (leaf.startsWith(q)) score = 1;
    else if (name.includes(q)) score = 2;
    else if (tool.description.toLowerCase().includes(q)) score = 3;
    if (score >= 0) scored.push({ tool, score });
  }
  scored.sort((a, b) => (a.score !== b.score ? a.score - b.score : byName(a.tool, b.tool)));
  return scored.slice(0, limit).map((s) => s.tool);
}

function byName(a: AgentToolSummary, b: AgentToolSummary): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
