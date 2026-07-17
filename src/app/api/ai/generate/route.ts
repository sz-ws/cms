import { z } from "zod";
import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { hitRateLimit } from "@/lib/rate-limit";

// docs/spec-ai-capability.md:admin 測試口 + 未來 UI 的掛點。POST-only,呼叫外部
// AI provider(有副作用/成本),故走 assertSameOrigin(mutation)+ requireAuth("admin")
// + rate limit(10 次/分鐘),guard 順序同 tokens/media-upload route 慣例。
//
// workers pool 地雷:`@/lib/ai` 的相依鏈經 buildProviderRegistry → loader,
// 靜態 import 會把 next/navigation 拖進被測試靜態 import 的本檔 —— 改為 handler
// 內 dynamic import(同 dx/notify.ts 慣例),route.ts 本身零 loader/services 靜態依賴。

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

const bodySchema = z
  .object({
    messages: z.array(messageSchema).min(1),
    maxTokens: z.number().int().positive().optional(),
    // 溫度透傳,不驗範圍 —— 上游 provider 自己會擋(spec)。
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

  const { generateAiText } = await import("@/lib/ai");
  const result = await generateAiText(parsed);
  // spec:「回 AiGenerateResult 原樣」—— ok:false(如 not_configured)仍是 200,
  // 這是 provider 結果的被動透傳,不是 HTTP 層錯誤。
  return Response.json(result);
}
