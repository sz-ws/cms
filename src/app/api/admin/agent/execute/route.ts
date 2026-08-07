import { z } from "zod";
import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { hitRateLimit } from "@/lib/rate-limit";
import { readBoundedJsonObject } from "@/lib/body-limit";

// docs/spec-admin-agent.md §4:確認卡按下之後的唯一執行入口。
//
//   POST /api/admin/agent/execute   admin session + same-origin
//   body: { toolName, args }        ← 前端把提案原樣送回
//
// 這是整個確認制的真相入口(spec §4:「真相只有一個入口」)。偽造 transcript 只能
// 騙 LLM,騙不到 DB —— 因為所有 write 都只發生在這裡,而這裡每一次都重新驗 admin、
// 重新驗 same-origin、重新驗 schema、記 audit,與 transcript 說了什麼無關。
//
// ── 不做提案 hash 綁定(spec §8 問題 3,v1 拍板)────────────────────────────
// 「要求 args 必須出自最近一次 /chat 的提案」需要 server 暫存提案(等於一張新表 +
// 一套過期規則),擋下來的卻只有「admin 自己送了一組沒被提案過的參數」——而 admin
// 本來就能直接打任何一支 API。確認制防的是 LLM 亂動,不是防 admin。
//
// ── kind 不設限 ────────────────────────────────────────────────────────────
// 本端點不拒絕 kind:"read" 的 tool。它不會鬆動任何安全性質:read 對 admin 本來就
// 全面開放(loop 內直接執行),而 write 的把關在「必須由人按下確認才會走到這裡」,
// 不在「這裡只收 write」。kind 仍會查出來並寫進 audit,所以事後分得清哪一列是什麼。
//
// workers pool 地雷同 chat route:registry/services 的相依鏈經 loader → interpret →
// next/navigation,一律 handler 內 dynamic import。

/** 單一提案的參數不該很大;上限遠小於 chat 的 transcript。 */
const MAX_BODY_BYTES = 64_000;
const MAX_TOOL_NAME_CHARS = 200;

const bodySchema = z
  .object({
    toolName: z.string().min(1).max(MAX_TOOL_NAME_CHARS),
    // 未驗的參數:真正的驗證是 invokeAgentTool 內以該 tool 自己的 zod schema 重跑。
    args: z.unknown(),
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

  // 一次確認 = 一次點擊。額度比 chat 寬(執行本身不打上游、成本低),但仍有上限:
  // 沒有上限的執行端點等於把「按錯一個迴圈」的代價交給 D1。
  if (
    await hitRateLimit(user.id, {
      namespace: "agent-execute",
      limit: 30,
      windowMs: 60_000,
    })
  ) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = await readBoundedJsonObject(req, MAX_BODY_BYTES, "agent-execute");
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
  // 省略 args 等同空物件(有些 tool 的 schema 就是 `z.object({}).strict()`);
  // 明確寫成 undefined 判定而不是 `??`,免得 null 被悄悄當成 {} 放行。
  const args = parsed.args === undefined ? {} : parsed.args;

  // 見檔頭:全部 handler 內 dynamic import。
  const [{ buildAgentToolRegistry }, { createServices }, { invokeAgentTool }, { recordAgentToolRun }] =
    await Promise.all([
      import("@/ext/agent-tools-runtime"),
      import("@/ext/services"),
      import("@/ext/agent-tools"),
      import("@/ext/agent-audit"),
    ]);

  // 與 /chat 走同一個接線點,兩邊認得的 tool 因此完全相同。
  const registry = await buildAgentToolRegistry();
  const tool = registry.get(parsed.toolName);
  if (!tool) {
    // 不存在的 tool:不記 audit(沒有東西被執行,也不讓任意字串寫進稽核表)。
    return Response.json(
      { ok: false, toolName: parsed.toolName, error: "unknown_tool" },
      { status: 400 },
    );
  }

  const services = await createServices("core");
  // invokeAgentTool 是「先驗 args 才執行」的唯一入口,且把所有失敗收斂成
  // { ok:false } —— 成功與失敗因此寫出同一種 audit 列。
  const outcome = await invokeAgentTool(tool, { user, services }, args);
  await recordAgentToolRun({
    actor: user,
    toolName: tool.name,
    kind: tool.kind,
    source: "execute",
    args,
    outcome,
  });

  if (!outcome.ok) {
    return Response.json(
      {
        ok: false,
        toolName: tool.name,
        error: outcome.error,
        ...(outcome.issues ? { issues: outcome.issues } : {}),
      },
      // args 沒過 schema 是「這個請求本身不對」→ 400,前端可以據此把確認卡標成
      // 參數錯誤;tool 執行時失敗(找不到那一筆、provider 拒絕…)是站上的真實
      // 狀況 → 200 透傳,同 /api/ai/generate 的哲學。
      { status: outcome.error === "invalid_args" ? 400 : 200 },
    );
  }

  return Response.json({ ok: true, toolName: tool.name, result: outcome.result });
}
