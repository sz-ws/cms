import { z } from "zod";
import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { hitRateLimit } from "@/lib/rate-limit";
import { readBoundedJsonObject } from "@/lib/body-limit";
import type {
  AiChatContentBlock,
  AiChatMessage,
} from "@/ext/providers/ai";

// docs/spec-admin-agent.md §4:agent loop 的入口。
//
//   POST /api/admin/agent/chat   admin session + same-origin
//   body: { messages }           ← transcript 由前端持有,server stateless
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
  const [{ buildAgentToolRegistry }, { createServices }, { loadAgentSystemPrompt }, { runAgentChat }] =
    await Promise.all([
      import("@/ext/agent-tools-runtime"),
      import("@/ext/services"),
      import("@/ext/agent-prompt"),
      import("@/ext/agent-loop"),
    ]);

  const [registry, services, system] = await Promise.all([
    // 兩個端點共用同一個接線點 —— /chat 看得到的 tool 與 /execute 認得的 tool
    // 因此不可能分叉(agent-tools-runtime.ts 檔頭)。
    buildAgentToolRegistry(),
    createServices("core"),
    loadAgentSystemPrompt(),
  ]);

  const outcome = await runAgentChat({
    messages,
    system,
    registry,
    ctx: { user, services },
  });
  // 上游/工具層的失敗一律以 200 + status:"error" 透傳(同 /api/ai/generate 的
  // 「provider 結果被動透傳」哲學):HTTP 層只表達「這個請求本身有沒有被接受」。
  return Response.json(outcome);
}
