import { z } from "zod";
import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { hitRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// docs/spec-ai-capability.md streaming 附錄:/api/ai/generate 的 streaming 手足
// —— 安全骨架與 body schema 與非 streaming 版一字不差(同一 namespace
// "ai-generate",共用同一個 10 次/分鐘的 rate limit 桶),差別只在回應改為
// NDJSON(一行一個 AiStreamEvent)而非單一 JSON body。
//
// workers pool 地雷:同 ../route.ts —— `@/lib/ai` 的相依鏈經
// buildProviderRegistry → loader,靜態 import 會把 next/navigation 拖進被測試
// 靜態 import 的本檔,故一樣改為 handler 內 dynamic import,route.ts 本身零
// loader/services 靜態依賴。

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

const bodySchema = z
  .object({
    messages: z.array(messageSchema).min(1),
    maxTokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
  })
  .strict();

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

  if (
    await hitRateLimit(user.id, {
      namespace: "ai-generate",
      limit: 10,
      windowMs: 60_000,
    })
  ) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  const { generateAiTextStream } = await import("@/lib/ai");

  // NDJSON over a real ReadableStream —— 逐事件送出、不整包緩衝,這是本端點
  // 存在的意義。generateAiTextStream 永不 throw(見該函式註解),但仍用
  // try/finally 保底,避免上游意外拋出時 controller 沒 close。
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const event of generateAiTextStream(parsed)) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "stream_error";
        controller.enqueue(
          encoder.encode(`${JSON.stringify({ type: "error", error: message })}\n`),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}
