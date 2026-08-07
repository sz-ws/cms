import { z } from "zod";
import type { SessionUser } from "@/lib/auth";
import type { Locale } from "@/lib/i18n/index";
import type { CoreServices } from "./services";

// docs/spec-admin-agent.md §2:行動層(agent tool registry)。
//
// 這一層存在的理由,是把「AI 能做什麼」變成一份可列舉、可驗證、可標注權限的清單,
// 而不是散在 prompt 裡的口頭約定。registry 形狀照 providers.ts(spec §2 明言同模式):
// 註冊 / 取得 / 列表,重複 name 一律 throw —— 兩個同名 tool 意味著 LLM 呼叫到哪一個
// 取決於註冊順序,那是連測試都寫不出斷言的不確定行為,寧可在載入期就炸掉
// (同 defineExtension 對重複 id、ProviderRegistry 對重複 provider id 的態度)。
//
// `kind` 是 spec §1 安全模型的載體,不是分類標籤:read 可在 agent loop 內直接執行,
// write **永遠**只能變成待人工確認的提案。Phase A 只負責讓每個 tool 帶上這個標注;
// 「loop 內不執行 write」由 Phase C 的 /chat 落實 —— 那條路徑目前根本不存在,
// 要加就得先改 spec 重新拍板(§1.2:自動核可不是預設關閉,是不存在的功能)。

/**
 * tool 執行時拿得到的東西。形狀刻意與 ApiCtx(types.ts)對齊 —— 讓 extension 之後
 * (Phase E)把既有 API handler 的邏輯直接搬進 tool 不必改形狀 —— 但保持獨立宣告,
 * 因為兩者的來源不同:ApiCtx 由 /api/ext 派發器建立、scope 綁在被呼叫的 extension;
 * AgentToolCtx 由 agent 端點建立,而且 Phase C 起會多帶 audit 所需的脈絡。
 */
export interface AgentToolCtx {
  user: SessionUser;
  services: CoreServices;
}

export type AgentToolKind = "read" | "write";

export interface AgentTool {
  /** 全域唯一。慣例見 AGENT_TOOL_NAME_RE 與 spec §2 例子(content.<type>.list)。 */
  name: string;
  /** 給 LLM 看的:何時該用、參數語意。空字串 = 這個 tool 對 LLM 不存在,故拒收。 */
  description: string;
  kind: AgentToolKind;
  /** args 驗證。Phase B 會轉成 JSON Schema 餵給 LLM。 */
  schema: z.ZodType;
  execute(ctx: AgentToolCtx, args: unknown): Promise<unknown>;
  /**
   * 確認卡的人話摘要(admin 介面語言)。省略 → 退回 description 第一句 + args 預覽。
   *
   * 為什麼要有這個方法:description 是寫給 LLM 看的英文,而確認卡那一行是 admin
   * **按下「確認執行」之前唯一讀到的字**。對一個繁中後台來說,那一行不該是英文。
   *
   * 收到的 args 是 **LLM 的原始 input,未經 schema 驗證** —— write 在 loop 內永不
   * 執行,所以在提案的時點根本沒有 parse 過(agent-loop.ts 的 proposal 分支)。
   * 實作必須逐欄防禦性讀取(readStringArg 之類),任何欄位缺失都要生得出一句合理的
   * 話,而且**絕不 throw**:摘要炸掉會讓 admin 面前那張卡失去它唯一的說明。
   * 真的 throw 或回空字串時,loop 會退回推導版摘要 —— 但那是保險絲,不是設計。
   */
  summarize?(args: unknown, locale: Locale): string;
}

/**
 * summarize 專用的防禦性欄位讀取:非物件 / 缺鍵 / 型別不對一律回空字串。
 *
 * 存在的理由就是上面那句「args 未經驗證」。把它放在契約旁邊而不是各自實作一份,
 * 是因為每個 summarize 作者都會遇到同一個陷阱(`(args as {id:string}).id` 在模型
 * 少填一個欄位時就是 undefined,接著 `.slice()` 一炸,卡片就白了)。
 */
export function readStringArg(args: unknown, key: string): string {
  if (typeof args !== "object" || args === null) return "";
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/**
 * 點分小寫識別字,至少兩段。段內允許底線,因為 content type key 的 `.`(如
 * gallery.item)在 tool name 裡會被壓成 `_`(gallery_item)—— 見 dx/agent-tools.ts
 * 的 contentToolSlug。extension id 與 content type name 兩者的字元集都不含底線,
 * 所以這個壓法不會造成兩個不同的 (extId, typeName) 撞出同一個名字。
 */
export const AGENT_TOOL_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
// 生成出來的最長 name 是 `content.<extId>_<typeName>.update`,在 id/type name 各自
// 頂到上限時是 78 字。留出餘裕,免得某天多一個字的動詞讓合法 manifest 生不出 tool。
const MAX_TOOL_NAME_LENGTH = 96;

/** 錯誤摘要上限。同 ai:generate 的 200 字慣例(spec-ai-capability.md)。 */
const ERROR_SUMMARY_MAX = 200;

function assertToolShape(tool: AgentTool): void {
  if (
    tool.name.length > MAX_TOOL_NAME_LENGTH ||
    !AGENT_TOOL_NAME_RE.test(tool.name)
  ) {
    throw new Error(`[agent-tools] invalid tool name "${tool.name}"`);
  }
  if (tool.description.trim().length === 0) {
    throw new Error(
      `[agent-tools] tool "${tool.name}" has an empty description`,
    );
  }
}

/**
 * 建 tool 的唯一入口。存在的理由是結構性地保證「args 一定先過 schema 才進 run」:
 * 若讓每個 tool 自己實作 execute(ctx, args: unknown),遲早有人直接把 args 當成
 * 已驗證的形狀用,而那個洞會出現在一個可以寫 DB 的 write tool 上。這裡把 parse
 * 綁進 execute,run 收到的就是 schema 的輸出型別。
 *
 * parse 會 throw —— 這是刻意的:呼叫端請走 invokeAgentTool(把 throw 收斂成
 * { ok:false }),或自行 try/catch。tool 本身不吞錯誤,否則錯誤會變成「看起來成功
 * 的空結果」,審計紀錄也就跟著失真。
 */
export function defineAgentTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  kind: AgentToolKind;
  schema: S;
  run: (ctx: AgentToolCtx, args: z.output<S>) => Promise<unknown>;
  /**
   * 見 AgentTool.summarize。args 刻意**不**用 z.output<S> —— 那會讓作者以為自己
   * 拿到的是驗過的形狀,而摘要跑在唯一沒有 parse 的時點上。
   */
  summarize?: (args: unknown, locale: Locale) => string;
}): AgentTool {
  const tool: AgentTool = {
    name: def.name,
    description: def.description,
    kind: def.kind,
    schema: def.schema,
    // async 是刻意的:parse 失敗要走 rejected promise,而不是同步 throw ——
    // 回傳型別寫著 Promise,呼叫端就有權只用 .catch()/await 攔錯。
    execute: async (ctx, args) => def.run(ctx, def.schema.parse(args)),
    ...(def.summarize ? { summarize: def.summarize } : {}),
  };
  assertToolShape(tool);
  return tool;
}

export interface AgentToolRegistry {
  register(tool: AgentTool): void;
  /** 找不到 → null(呼叫端據此回 unknown_tool,不 throw)。 */
  get(name: string): AgentTool | null;
  /** 省略 kind = 全部。回傳依 name 排序,讓餵給 LLM 的清單順序穩定。 */
  list(kind?: AgentToolKind): AgentTool[];
  names(): string[];
}

export class AgentToolRegistryImpl implements AgentToolRegistry {
  private readonly byName = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    // 形狀在此重驗一次:tool 未必都經 defineAgentTool 建立(Phase E 的 extension
    // 可以手寫物件),registry 是所有來源的共同關口。
    assertToolShape(tool);
    if (this.byName.has(tool.name)) {
      throw new Error(`[agent-tools] duplicate tool name "${tool.name}"`);
    }
    this.byName.set(tool.name, tool);
  }

  registerAll(tools: readonly AgentTool[]): void {
    for (const tool of tools) this.register(tool);
  }

  get(name: string): AgentTool | null {
    return this.byName.get(name) ?? null;
  }

  list(kind?: AgentToolKind): AgentTool[] {
    const all = [...this.byName.values()];
    const filtered = kind ? all.filter((t) => t.kind === kind) : all;
    return [...filtered].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  names(): string[] {
    return this.list().map((t) => t.name);
  }
}

/** invokeAgentTool 的結果。永不 throw,同 AiGenerateResult 哲學。 */
export type AgentToolResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string; issues?: string[] };

function summarizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.length > ERROR_SUMMARY_MAX
    ? `${raw.slice(0, ERROR_SUMMARY_MAX)}…`
    : raw;
}

/**
 * 執行一個 tool 並把所有失敗收斂成 { ok:false, error }。
 *
 * 為什麼要有這個 wrapper 而不是讓呼叫端直接 tool.execute():agent 端點(Phase C)
 * 每一次執行都要記 audit,而 audit 需要「成功與否 + 可讀的失敗原因」這組固定形狀。
 * 把它定在這裡,兩個端點(/chat 的 read 與 /execute 的 write)就不可能各記各的。
 * 錯誤字串截 200 字,與 ai:generate 的上游錯誤摘要慣例一致。
 *
 * 注意:本函式**不**檢查 kind —— 「write 不得在 loop 內執行」是呼叫端的責任,
 * 而且應該在挑 tool 的時候就擋掉(loop 只拿 list("read")),不是執行到一半才發現。
 */
export async function invokeAgentTool(
  tool: AgentTool,
  ctx: AgentToolCtx,
  args: unknown,
): Promise<AgentToolResult> {
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      error: "invalid_args",
      issues: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      ),
    };
  }
  try {
    return { ok: true, result: await tool.execute(ctx, parsed.data) };
  } catch (e) {
    console.error(`[agent-tools] "${tool.name}" failed`, e);
    return { ok: false, error: summarizeError(e) };
  }
}
