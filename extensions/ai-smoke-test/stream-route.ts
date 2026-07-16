import { z } from "zod";
import type { ApiCtx } from "@/ext/types";
import type { AiProvider } from "@/ext/providers/ai";

// route.ts 的 streaming 手足:同樣走 extension 真正該走的路
// (ctx.services.providers.get<AiProvider>("ai:generate")),不是 core 呼叫端的
// src/lib/ai.ts 捷徑——驗證 generateStream() 這條新路徑從 extension 端也真的打得通。
// 若解析出的 provider 沒實作 generateStream(合法情況,見 AiProvider 介面註解),
// 回單一 NDJSON error 行,不是 500——同 not_configured 一樣是合法的驗證結果。

const bodySchema = z
  .object({
    prompt: z.string().min(1).max(4000),
  })
  .strict();

export async function generateStreamHandler(
  req: Request,
  _params: Record<string, string>,
  ctx: ApiCtx,
): Promise<Response> {
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  const provider = ctx.services.providers.get<AiProvider>("ai:generate");

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      if (!provider.generateStream) {
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ type: "error", error: "streaming_not_supported" })}\n`,
          ),
        );
        controller.close();
        return;
      }
      try {
        for await (const event of provider.generateStream({
          messages: [{ role: "user", content: parsed.prompt }],
        })) {
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
