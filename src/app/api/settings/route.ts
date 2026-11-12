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
import { publicContentChanged } from "@/lib/public-cache";

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
  // 2.0:站名、圖示、語言、公告、商店與插件設定都畫在公開頁上 —— 存起來的公開頁全部重算。
  // 不分哪個 key:分了就要維護一張「哪些設定會上公開頁」的表,漏一個就是舊頁面。這個存檔是人按的,
  // 一次存檔一次重算;背景記帳直接呼叫 setSettings,不經過這裡。
  publicContentChanged("settings");
  return Response.json({ ok: true });
}
