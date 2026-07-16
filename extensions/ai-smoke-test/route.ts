import { z } from "zod";
import type { ApiCtx } from "@/ext/types";
import type { AiProvider } from "@/ext/providers/ai";

// 純測試用的 apiRoute handler:走 extension 真正該走的路(ctx.services.providers
// .get<AiProvider>("ai:generate")),不是 core 呼叫端的 src/lib/ai.ts 捷徑——這支
// extension 存在的唯一目的就是驗證「extension 拿到的 provider 真的能打通」。
// ai:generate 永遠有內建 fallback provider(CoreAiProvider,見 providers.ts),
// get() 不會 throw;core.ai.mode 未設定時回 { ok:false, error:"not_configured" },
// 這也是合法的驗證結果(代表管線本身沒斷,只是還沒設定金鑰)。

const bodySchema = z
  .object({
    prompt: z.string().min(1).max(4000),
  })
  .strict();

export async function generateHandler(
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
  const result = await provider.generate({
    messages: [{ role: "user", content: parsed.prompt }],
  });
  return Response.json(result);
}
