import { z } from "zod";
import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import {
  allowedSettingKeys,
  setSettings,
  splitRegistrySourceTokens,
} from "@/lib/settings";

const bodySchema = z.object({
  entries: z.record(z.string(), z.unknown()),
});

// 05 §4:PUT /api/settings。requireAuth("admin") → zod → key 白名單 → setSettings。
export async function PUT(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    const r = originErrorResponse(e);
    if (r) return r;
    throw e;
  }

  try {
    await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  // key 白名單(05 §4):CORE_SETTINGS + enabled extension settings。
  const allowed = await allowedSettingKeys();
  for (const key of Object.keys(parsed.entries)) {
    if (!allowed.has(key)) {
      return Response.json({ error: "invalid_key" }, { status: 400 });
    }
  }

  // core.registrySources 特別處理:token 拆到 core.registryTokens(secret 管線
  // AES-GCM 加密),registrySources 本體不落地明文 token。
  let entries = parsed.entries;
  if ("core.registrySources" in entries) {
    entries = {
      ...entries,
      ...(await splitRegistrySourceTokens(entries["core.registrySources"])),
    };
  }

  await setSettings(entries);
  return Response.json({ ok: true });
}
