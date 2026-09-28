import { invokeAgentTool } from "./agent-tools";
import type { AgentTool, AgentToolCtx, AgentToolRegistry, AgentToolResult } from "./agent-tools";
import { recordAgentToolRun } from "./agent-audit";
import { toAiToolDefs } from "./agent-loop";
import { toWireToolName } from "./providers/ai-chat";
import type { Locale } from "@/lib/i18n/index";

// AI 連線的 MCP 伺服器本體:JSON-RPC 2.0 的訊息 → 後台助理的**同一份** tool registry。
//
// 刻意手寫、不引 @modelcontextprotocol/sdk:這裡只需要 initialize / ping / tools/list /
// tools/call 四個方法,而 Worker bundle 已經很大。傳輸層是 Streamable HTTP 的最小子集 ——
// 每個 POST 回一個 JSON(不開 SSE、不發 session id),伺服器端沒有任何連線狀態。
//
// ── 與面板的確認制是什麼關係 ─────────────────────────────────────────────────
// 面板(agent-loop.ts)的鐵律是「write 在 loop 內永不執行,只變成確認卡」。MCP 沒有這張
// 卡:呼叫 tool 之前問使用者的,是那個 AI App(Claude、ChatGPT 都會在動手前問)。所以:
//   * write tool 只在連線有「可以修改」權限時才**列出**、才**接受呼叫** —— 管理員在同意
//     畫面上選「只能查看」,write 就不存在於這條連線上。
//   * 被呼叫時走的是與 /api/admin/agent/execute **同一條**執行路徑:invokeAgentTool
//     (先過該 tool 自己的 zod schema 才執行)→ recordAgentToolRun。source = "mcp",
//     `app` 記是哪個 App —— 事後分得清哪一筆是在面板按的、哪一筆是 App 那邊按的。
//   * read 也記(spec §1.3:查了什麼與改了什麼是同一個問題的兩半)。
// 本檔**不**自己判斷 kind 以外的任何權限:誰能連線、連線能不能寫,由 src/lib/mcp/grants.ts
// 決定後以 canWrite 傳進來。
//
// ── tool 名 ──────────────────────────────────────────────────────────────────
// 行動層的正名是點分(content.gallery_item.list),但各家 LLM 的 tool name 規則是
// ^[a-zA-Z0-9_-]{1,64}$ —— AI App 會把我們的 tool 原樣交給它的模型。所以對外用面板送上游
// 時的同一個 wire 名(toWireToolName:點換破折號),收到呼叫時查表換回來;正名也照收。
//
// ── 回傳給 App 的內容 ────────────────────────────────────────────────────────
// 成功:結果的 JSON 文字(與面板餵給模型的是同一份,secret 在 registry 那一層就進不來)。
// write 成功時前面多一行 tool 自己的 summarize() —— 那是作者為「這個動作做了什麼」寫的
// 人話,App 的模型拿它回報最不容易說錯。display() 的圖卡是面板專用的 widget,不送。
// 失敗:isError 的結果(不是 JSON-RPC 錯誤)—— 模型看得到失敗才會換個做法(MCP 規格對
// tool 執行錯誤的建議)。只有「沒有這個 tool」是協定層的錯。

/** 支援的協定版本,新的在前。initialize 請求的版本不在這裡 → 回我們最新的,由 client 決定。 */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const MCP_LATEST_PROTOCOL: string = MCP_PROTOCOL_VERSIONS[0];

/** 單筆結果送回 App 的上限(字元)。超過就截斷並註明 —— 同面板 §4.5 的理由:模型要知道自己拿到的是半份。 */
const MCP_RESULT_MAX_CHARS = 24_000;

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;

type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpSession {
  /** 這條連線能不能用 write tool(同意畫面上選了「可以查看與修改」)。 */
  canWrite: boolean;
  /** 連線的 App 名稱(稽核用)。 */
  app: string;
  /** write 成功時那一行摘要的語言(站台的後台語言)。 */
  locale: Locale;
  /** serverInfo 與給模型的說明用。 */
  siteTitle: string;
  serverVersion: string;
  /** registry 與執行脈絡都是用到才建(initialize、ping 不需要)。 */
  registry: () => Promise<AgentToolRegistry>;
  toolCtx: () => Promise<AgentToolCtx>;
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

/** 這條連線看得到的 tools(只能查看 → 只有 read)。依 name 排序(registry.list 已排)。 */
function visibleTools(registry: AgentToolRegistry, canWrite: boolean): AgentTool[] {
  return canWrite ? registry.list() : registry.list("read");
}

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
}

/** registry 的 tools → MCP 的 tool 宣告。inputSchema 與面板給上游的是同一份轉換。 */
function toMcpToolDefs(tools: readonly AgentTool[]): McpToolDef[] {
  const defs = toAiToolDefs(tools);
  return tools.map((tool, i) => ({
    name: toWireToolName(tool.name),
    description: tool.description,
    inputSchema: defs[i].inputSchema,
    annotations: {
      readOnlyHint: tool.kind === "read",
      // read 什麼都不改;write 沒有宣告就當作會改到既有資料(見 AgentTool.destructive)。
      destructiveHint: tool.kind === "write" && tool.destructive !== false,
      // 動的只是這個站自己的資料,不是外面的世界。
      openWorldHint: false,
    },
  }));
}

/**
 * wire 名或正名 → tool。連這條連線看不到的 write 也找得到:只能查看的連線呼叫 write 時,
 * 回答是「沒有修改權限」,而不是「沒有這個 tool」—— 後者會讓 App 的模型以為站上缺功能。
 */
function findTool(registry: AgentToolRegistry, name: string): AgentTool | null {
  const direct = registry.get(name);
  if (direct) return direct;
  return registry.list().find((tool) => toWireToolName(tool.name) === name) ?? null;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? "null";
  } catch {
    return '"[unserializable result]"';
  }
}

function bounded(raw: string): string {
  if (raw.length <= MCP_RESULT_MAX_CHARS) return raw;
  return `${raw.slice(0, MCP_RESULT_MAX_CHARS)}\n…[truncated: showing ${MCP_RESULT_MAX_CHARS} of ${raw.length} characters. Narrow the query or fetch a single entry to see the rest.]`;
}

/** write 成功時那一行摘要。作者的 summarize 壞了或回空白就不附(結果本身仍在)。 */
function writeSummary(tool: AgentTool, args: unknown, locale: Locale): string | null {
  if (!tool.summarize) return null;
  try {
    const line = tool.summarize(args, locale).trim();
    return line.length > 0 ? line : null;
  } catch (e) {
    console.error(`[mcp] "${tool.name}".summarize failed`, e);
    return null;
  }
}

interface TextContent {
  type: "text";
  text: string;
}

interface CallToolResult {
  content: TextContent[];
  isError?: boolean;
}

function toolResult(tool: AgentTool, args: unknown, outcome: AgentToolResult, locale: Locale): CallToolResult {
  if (!outcome.ok) {
    return {
      content: [{ type: "text", text: jsonText({ error: outcome.error, ...(outcome.issues ? { issues: outcome.issues } : {}) }) }],
      isError: true,
    };
  }
  const body: TextContent = { type: "text", text: bounded(jsonText(outcome.result)) };
  const summary = tool.kind === "write" ? writeSummary(tool, args, locale) : null;
  return { content: summary ? [{ type: "text", text: `Done: ${summary}` }, body] : [body] };
}

const READ_ONLY_REFUSAL =
  "This connection can only look things up, so nothing was changed. " +
  "To make changes, a site admin has to connect this app again and choose the option that allows changes.";

async function callTool(params: Record<string, unknown>, session: McpSession): Promise<CallToolResult | JsonRpcError> {
  const name = params.name;
  if (typeof name !== "string" || name.length === 0 || name.length > 200) {
    return rpcError(JSONRPC_INVALID_PARAMS, "tools/call needs a tool name.");
  }
  const registry = await session.registry();
  const tool = findTool(registry, name);
  if (!tool) return rpcError(JSONRPC_INVALID_PARAMS, `Unknown tool: ${name}`);
  if (tool.kind === "write" && !session.canWrite) {
    // 沒有執行任何東西 → 不記稽核(同面板對 unknown_tool 的處理)。
    return { content: [{ type: "text", text: READ_ONLY_REFUSAL }], isError: true };
  }

  // 省略 arguments 等同空物件(同 /execute 對 args 的處理);null 不當成 {}。
  const args = params.arguments === undefined ? {} : params.arguments;
  const ctx = await session.toolCtx();
  const outcome = await invokeAgentTool(tool, ctx, args);
  await recordAgentToolRun({
    actor: ctx.user,
    toolName: tool.name,
    kind: tool.kind,
    source: "mcp",
    app: session.app,
    args,
    outcome,
  });
  return toolResult(tool, args, outcome, session.locale);
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

interface JsonRpcError {
  rpcError: { code: number; message: string };
}

function rpcError(code: number, message: string): JsonRpcError {
  return { rpcError: { code, message } };
}

function isRpcError(value: unknown): value is JsonRpcError {
  return typeof value === "object" && value !== null && "rpcError" in value;
}

function respond(id: JsonRpcId, outcome: unknown): JsonRpcResponse {
  return isRpcError(outcome)
    ? { jsonrpc: "2.0", id, error: outcome.rpcError }
    : { jsonrpc: "2.0", id, result: outcome };
}

function instructions(siteTitle: string): string {
  const site = siteTitle ? `"${siteTitle}"` : "this website";
  return (
    `These tools work on the back office of ${site}: its content, settings and, when installed, its shop orders. ` +
    "Tools marked read-only only look things up. The other tools change the live site as soon as they run, " +
    "so tell the user exactly what you are about to change and wait for their go-ahead before calling one."
  );
}

function initializeResult(params: Record<string, unknown>, session: McpSession): unknown {
  const requested = params.protocolVersion;
  const protocolVersion =
    typeof requested === "string" && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : MCP_LATEST_PROTOCOL;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: {
      name: "cms",
      ...(session.siteTitle ? { title: session.siteTitle } : {}),
      version: session.serverVersion,
    },
    instructions: instructions(session.siteTitle),
  };
}

async function dispatch(method: string, params: Record<string, unknown>, session: McpSession): Promise<unknown> {
  switch (method) {
    case "initialize":
      return initializeResult(params, session);
    case "ping":
      return {};
    case "tools/list": {
      const registry = await session.registry();
      // 沒有分頁:一個站的 tool 數量是幾十個,不是幾千個。cursor 照收、忽略。
      return { tools: toMcpToolDefs(visibleTools(registry, session.canWrite)) };
    }
    case "tools/call":
      return callTool(params, session);
    default:
      return rpcError(JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

function validId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * 一則 JSON-RPC 訊息 → 回應。notification 與 client 送來的 response 回 null(不回任何東西)。
 * 永不 throw:tool 內部的失敗已由 invokeAgentTool 收斂;走到這裡的例外是 bug,回 -32603
 * 並留 log,不讓一則壞訊息把同一批的其他訊息一起拖下水。
 */
async function handleMcpMessage(message: unknown, session: McpSession): Promise<JsonRpcResponse | null> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return { jsonrpc: "2.0", id: null, error: { code: JSONRPC_INVALID_REQUEST, message: "Invalid request" } };
  }
  const msg = message as Record<string, unknown>;
  const hasId = "id" in msg && msg.id !== undefined;
  const id: JsonRpcId = validId(msg.id) ? msg.id : null;

  if (msg.jsonrpc !== "2.0") {
    return { jsonrpc: "2.0", id, error: { code: JSONRPC_INVALID_REQUEST, message: "Invalid request" } };
  }
  if (typeof msg.method !== "string") {
    // client 回應我們的請求(我們從不發請求)→ 沒有東西要回。
    if ("result" in msg || "error" in msg) return null;
    return { jsonrpc: "2.0", id, error: { code: JSONRPC_INVALID_REQUEST, message: "Invalid request" } };
  }
  if (msg.params !== undefined && (typeof msg.params !== "object" || msg.params === null || Array.isArray(msg.params))) {
    return hasId ? { jsonrpc: "2.0", id, error: { code: JSONRPC_INVALID_PARAMS, message: "params must be an object" } } : null;
  }
  const params = (msg.params ?? {}) as Record<string, unknown>;

  // notification(沒有 id):notifications/initialized、cancelled… 無狀態伺服器都不需要處理。
  if (!hasId) return null;
  if (!validId(msg.id)) {
    return { jsonrpc: "2.0", id: null, error: { code: JSONRPC_INVALID_REQUEST, message: "id must be a string or number" } };
  }

  try {
    return respond(id, await dispatch(msg.method, params, session));
  } catch (e) {
    console.error(`[mcp] "${msg.method}" failed`, e);
    return { jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } };
  }
}

export type McpHttpOutcome =
  | { status: 200; body: JsonRpcResponse | JsonRpcResponse[] }
  | { status: 202 };

/** 一個 POST body(已 parse 的 JSON,或 parse 失敗的 undefined)→ HTTP 層該回什麼。 */
export async function handleMcpBody(body: unknown, parsed: boolean, session: McpSession): Promise<McpHttpOutcome> {
  if (!parsed) {
    return { status: 200, body: { jsonrpc: "2.0", id: null, error: { code: JSONRPC_PARSE_ERROR, message: "Parse error" } } };
  }
  // 2025-03-26 允許一次送一批;之後的版本拿掉了,但收下不會壞任何事。
  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > 50) {
      return { status: 200, body: { jsonrpc: "2.0", id: null, error: { code: JSONRPC_INVALID_REQUEST, message: "Invalid request" } } };
    }
    const out: JsonRpcResponse[] = [];
    for (const message of body) {
      const response = await handleMcpMessage(message, session);
      if (response) out.push(response);
    }
    return out.length > 0 ? { status: 200, body: out } : { status: 202 };
  }
  const response = await handleMcpMessage(body, session);
  return response ? { status: 200, body: response } : { status: 202 };
}
