import { z } from "zod";
import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { hitRateLimit } from "@/lib/rate-limit";
import { readBoundedJsonObject } from "@/lib/body-limit";
import type {
  AiChatContentBlock,
  AiChatMessage,
} from "@/ext/providers/ai";
import type { AgentChatOutcome, AgentLoopEvent } from "@/ext/agent-loop";

// docs/spec-admin-agent.md §4:agent loop 的入口。
//
//   POST /api/admin/agent/chat   admin session + same-origin
//   body: { messages }           ← transcript 由前端持有,server stateless
//
// 兩種回應形狀,由請求端的 Accept 決定(1.32.0):
//   · 預設 → 單一 JSON body,就是 AgentChatOutcome。
//   · `Accept: text/event-stream` → SSE。過程事件逐一送出,**最後一個事件是
//     `event: outcome`,payload 與 JSON 模式的 body 是同一個物件**。
// 兩條路共用同一段 guard 與同一次 runAgentChat 呼叫;差別只在「怎麼把結果交出去」。
// 沒帶那個 Accept 的呼叫端行為與 1.31.0 一字不差。
//
// guard 順序照既有 admin mutation 慣例(/api/ai/generate、tokens、media-upload):
// same-origin → requireAuth("admin") → rate limit → body 上限 → zod。
// admin-only 是 spec §1.1 的第一條,不可協商:editor/guest 打不到這個端點。
//
// 本檔只做 guard 與接線;「LLM 說了什麼 → 站上發生什麼」的規則全在
// @/ext/agent-loop(守門測試因此不必先組出一個 HTTP request)。
//
// workers pool 地雷:agent-loop / agent-prompt / services 的相依鏈都會經 loader →
// interpret → next/navigation,靜態 import 會讓本檔連同它的測試載不起來 —— 全部
// 改為 handler 內 dynamic import(同 /api/ai/generate 的既有慣例),頂層只留
// type import(編譯期抹除)。

/** transcript 的位元組上限。多輪對話會長,但 256 KB 已遠大於任何合理的 8 步對話。 */
const MAX_BODY_BYTES = 256_000;
/** 訊息則數上限。前端該做的是開新對話,不是無限累積同一份 transcript。 */
const MAX_MESSAGES = 80;
/** 單則訊息的 content block 數上限。 */
const MAX_BLOCKS = 40;
/** 單一文字/結果字串的字元上限(loop 自己產生的 tool_result 遠小於此)。 */
const MAX_BLOCK_CHARS = 24_000;
/** tool_use / tool_result 識別碼與 tool 名稱的長度上限。 */
const MAX_ID_CHARS = 200;

const textBlockSchema = z
  .object({ type: z.literal("text"), text: z.string().max(MAX_BLOCK_CHARS) })
  .strict();

const toolUseBlockSchema = z
  .object({
    type: z.literal("tool_use"),
    id: z.string().min(1).max(MAX_ID_CHARS),
    name: z.string().min(1).max(MAX_ID_CHARS),
    // 未驗的參數 —— 真正的驗證在執行端(spec §4:/execute 每次重新驗 schema)。
    input: z.unknown(),
  })
  .strict();

const toolResultBlockSchema = z
  .object({
    type: z.literal("tool_result"),
    toolUseId: z.string().min(1).max(MAX_ID_CHARS),
    content: z.string().max(MAX_BLOCK_CHARS),
    isError: z.boolean().optional(),
  })
  .strict();

const bodySchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z
              .array(
                z.discriminatedUnion("type", [
                  textBlockSchema,
                  toolUseBlockSchema,
                  toolResultBlockSchema,
                ]),
              )
              .min(1)
              .max(MAX_BLOCKS),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_MESSAGES),
  })
  .strict();

type ParsedBlock = z.infer<typeof bodySchema>["messages"][number]["content"][number];

/**
 * zod 推出的形狀 → AiChatMessage。
 *
 * 不用 `as`:`z.unknown()` 在 zod 4 會讓那個鍵在推導型別上變成選填,與
 * AiChatContentBlock 的 `input: unknown`(必填)不相容。逐塊重建讓編譯器真的檢查
 * 這兩個形狀對得上 —— 一個 cast 會在 Phase B 改了 block 形狀時安靜地繼續編譯。
 */
function toChatBlock(block: ParsedBlock): AiChatContentBlock {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.input,
    };
  }
  return {
    type: "tool_result",
    toolUseId: block.toolUseId,
    content: block.content,
    ...(block.isError === undefined ? {} : { isError: block.isError }),
  };
}

export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    const r = originErrorResponse(e);
    if (r) return r;
    throw e;
  }

  let user;
  try {
    user = await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  // ai-generate 是 10/分鐘;對話是一來一往的互動,額度稍高才不會在正常使用中撞牆。
  // 每一次呼叫最多會打 8 次上游,所以這個數字同時是成本上限(20 × 8)。
  if (
    await hitRateLimit(user.id, {
      namespace: "agent-chat",
      limit: 20,
      windowMs: 60_000,
    })
  ) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = await readBoundedJsonObject(req, MAX_BODY_BYTES, "agent-chat");
  if (!body.ok) {
    return body.reason === "too_large"
      ? Response.json({ error: "payload_too_large" }, { status: 413 })
      : Response.json({ error: "invalid_input" }, { status: 400 });
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(body.value);
  } catch {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  const messages: AiChatMessage[] = parsed.messages.map((message) => ({
    role: message.role,
    content: message.content.map(toChatBlock),
  }));

  // 見檔頭:全部 handler 內 dynamic import。
  const [
    { buildAgentToolRegistry },
    { createServices },
    { loadAgentSystemPrompt, resolveLocale },
    { runAgentChat },
  ] = await Promise.all([
    import("@/ext/agent-tools-runtime"),
    import("@/ext/services"),
    import("@/ext/agent-prompt"),
    import("@/ext/agent-loop"),
  ]);

  // 解析一次,兩個消費者共用:system prompt 的「Reply in …」與確認卡摘要的語言
  // (AgentTool.summarize,1.31.0)。分別解析等於留一條它們會分岔的縫。
  const locale = await resolveLocale();
  const [registry, services, system] = await Promise.all([
    // 兩個端點共用同一個接線點 —— /chat 看得到的 tool 與 /execute 認得的 tool
    // 因此不可能分叉(agent-tools-runtime.ts 檔頭)。
    buildAgentToolRegistry(),
    createServices("core"),
    loadAgentSystemPrompt(locale),
  ]);

  const params = {
    messages,
    system,
    registry,
    ctx: { user, services },
    locale,
  };

  if (wantsEventStream(req)) {
    return sseResponse((onEvent) =>
      // signal:client 關掉分頁/按下開新對話時,loop 在下一步就停,不再打上游。
      runAgentChat({ ...params, onEvent, signal: req.signal }),
    );
  }

  const outcome = await runAgentChat(params);
  // 上游/工具層的失敗一律以 200 + status:"error" 透傳(同 /api/ai/generate 的
  // 「provider 結果被動透傳」哲學):HTTP 層只表達「這個請求本身有沒有被接受」。
  return Response.json(outcome);
}

/** 只認明確的 `text/event-stream` 子字串。不接受萬用的 accept-all 值 —— 拿它當判準
 *  會讓每一個既有呼叫端在毫無改動的情況下換到另一種回應形狀。 */
function wantsEventStream(req: Request): boolean {
  return (req.headers.get("accept") ?? "").includes("text/event-stream");
}

/**
 * 把一次 runAgentChat 包成 SSE。
 *
 * 契約(前端的 SSE parser 依此而寫):
 *   · 每個過程事件 → `event: <AgentLoopEvent.type>` + `data: <該事件的 JSON>`
 *   · **最後一個** → `event: outcome` + `data: <AgentChatOutcome 的 JSON>`,然後關流
 *
 * outcome 送的是 runAgentChat 原樣回傳的物件 —— 與 JSON 模式**同一個值**,不是
 * 「為串流另外整理過的版本」。前端的 transcript 因此只認 outcome 一個來源
 * (components/admin/agent/transcript.ts 的鐵律),delta 純屬暫態顯示。
 *
 * client 斷線:`req.signal` 傳進 loop(步間檢查,不再打下一次上游),同時 enqueue
 * 本身會 throw(controller 已關),故一律吞掉 —— 對著一條沒人聽的流報錯沒有意義。
 */
function sseResponse(
  run: (onEvent: (event: AgentLoopEvent) => void) => Promise<AgentChatOutcome>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // client 已斷線。loop 會在下一步的 signal 檢查停下來。
        }
      };
      try {
        const outcome = await run((event) => send(event.type, event));
        send("outcome", outcome);
      } catch (e) {
        // runAgentChat 永不 throw(該函式的註解),這是保底:少了它,一個意外的
        // 例外會變成「串流開著、永遠不送 outcome」,前端就一直轉。
        send("outcome", {
          status: "error",
          error: e instanceof Error ? e.message : "stream_error",
          appended: [],
          steps: 0,
          toolCalls: [],
        } satisfies AgentChatOutcome);
      } finally {
        try {
          controller.close();
        } catch {
          // 已因斷線關閉。
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // 反向代理(nginx 等)預設會緩衝 upstream 回應,逐字送出就全白費。
      "X-Accel-Buffering": "no",
    },
  });
}
