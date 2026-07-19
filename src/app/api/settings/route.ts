import { z } from "zod";
import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import {
  allowedSettingFields,
  allowedSettingKeys,
  isValidRegistrySources,
  setSettings,
  splitRegistrySourceTokens,
} from "@/lib/settings";
import { validateSettingEntries } from "@/lib/setting-validation";

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
  if (
    "core.registrySources" in parsed.entries &&
    !isValidRegistrySources(parsed.entries["core.registrySources"])
  ) {
    return Response.json(
      {
        error: "invalid_values",
        fields: [{ key: "core.registrySources", code: "invalid_format" }],
      },
      { status: 400 },
    );
  }

  let entries = parsed.entries;
  if ("core.registrySources" in entries) {
    entries = {
      ...entries,
      ...(await splitRegistrySourceTokens(entries["core.registrySources"])),
    };
  }

  const fields = await allowedSettingFields();
  const fieldErrors = validateSettingEntries(fields, entries);
  if (fieldErrors.length > 0) {
    return Response.json(
      { error: "invalid_values", fields: fieldErrors },
      { status: 400 },
    );
  }

  await setSettings(entries);
  return Response.json({ ok: true });
}
