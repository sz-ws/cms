import { z } from "zod";
import {
  authErrorResponse,
  createPasswordHashingProfile,
  isSupportedPasswordHashingIterations,
  probePasswordHashingWorkFactor,
  requireAuth,
} from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { PASSWORD_HASHING_SETTING, setSettings } from "@/lib/settings";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";

const bodySchema = z
  .object({ iterations: z.number().int(), commit: z.boolean().optional() })
  .strict();

/**
 * 部署端存活 probe：不在 Worker 內量 Date.now()（同步 CPU 執行時時鐘不前進），
 * 而是由瀏覽器觀察這個 request 有沒有完整回來。超過 CPU limit 時 Cloudflare
 * 會在此 handler 回應前終止。probe 成功前不寫設定，最後只有 commit 才原子寫入
 * 「iterations + matching dummy hash」，因此非 CPU 的途中錯誤不會半套改值。
 */
export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    const r = originErrorResponse(e);
    if (r) return r;
    throw e;
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  if (!isSupportedPasswordHashingIterations(parsed.iterations)) {
    return Response.json({ error: "invalid_iterations" }, { status: 400 });
  }

  // 首次 setup 尚未有 admin，之後重校準則只允許 admin 執行。
  const existingUsers = await db().select({ id: users.id }).from(users).limit(1);
  if (existingUsers.length > 0) {
    try {
      await requireAuth("admin");
    } catch (e) {
      const r = authErrorResponse(e);
      if (r) return r;
      throw e;
    }
  }

  if (!parsed.commit) {
    await probePasswordHashingWorkFactor(parsed.iterations);
    return Response.json({ ok: true, iterations: parsed.iterations });
  }

  const profile = await createPasswordHashingProfile(parsed.iterations);
  await setSettings({ [PASSWORD_HASHING_SETTING]: profile });
  return Response.json({ ok: true, iterations: profile.iterations });
}
