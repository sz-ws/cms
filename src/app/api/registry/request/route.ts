import { z } from "zod";
import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { hitRateLimit } from "@/lib/rate-limit";
import { readBoundedJsonObject } from "@/lib/body-limit";
import {
  assertKnownRegistrySource,
  sendAccessRequest,
  UnknownRegistrySource,
  type AccessRequestReply,
} from "@/lib/registry-client";
import { EXTENSION_ID_RE } from "@/lib/registry-asset";
import { sanitizeRegistryText } from "@/lib/registry-text";

// 1.56.0 付費插件協定:POST /api/registry/request —— 商店的「申請使用」。
// body { source, extension, note?, contact? }。admin + 同源檢查;每人每分鐘 5 次(只是禮貌,
// 防洗版的限制在閘道:每個 (金鑰, 插件) 一筆待處理、每天上限、body 上限)。
//
// 伺服器帶這個來源的 token 轉送到 `<source>/requests`(見 registry-client 的 sendAccessRequest):
//   - source 必須完全等於已設定的來源(SSRF 防線,同 install route)
//   - 不跟隨 redirect、8 秒逾時
//   - contact: true 時,名字與 email 取自登入的帳號,不收瀏覽器送來的值 —— 申請視窗列出的
//     就是實際送出的
// core 不存申請狀態:送出後商店重讀索引,閘道回 access: "requested"。
//
// 回應(給商店畫面):
//   202 { ok: true, message? }                  registry 收到了
//   404 { error: "requests_not_accepted" }      這個 registry 不收線上申請(按鈕改成聯絡提供者)
//   409 { error: "already_granted" }            已經開通了
//   413 / 429                                   registry 說太長 / 太多次
//   502 { error: "source_key_invalid" }         401 / 403:這個來源的金鑰不能用
//   502 { error: "request_failed" }             其他(連不上、逾時、3xx、5xx)

const NOTE_MAX = 500;
const MAX_BODY_BYTES = 4 * 1024;

const bodySchema = z
  .object({
    source: z.string().min(1).max(2048),
    extension: z.string().regex(EXTENSION_ID_RE),
    note: z.string().max(NOTE_MAX * 2).optional(),
    contact: z.boolean().optional(),
  })
  .strict();

type Body = z.infer<typeof bodySchema>;

async function guard(req: Request): Promise<{ userId: string; name: string; email: string } | Response> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    const r = originErrorResponse(e);
    if (r) return r;
    throw e;
  }
  try {
    const user = await requireAuth("admin");
    return { userId: user.id, name: user.name, email: user.email };
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }
}

async function readBody(req: Request): Promise<Body | Response> {
  const raw = await readBoundedJsonObject(req, MAX_BODY_BYTES, "registry-request");
  if (!raw.ok) {
    return raw.reason === "too_large"
      ? Response.json({ error: "payload_too_large" }, { status: 413 })
      : Response.json({ error: "invalid_input" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw.value);
  if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
  return parsed.data;
}

/** 留言:單行純文字(同 registry 文字的消毒),≤ 500 字;空的就不送。 */
function cleanNote(note: string | undefined): string | undefined | null {
  if (note === undefined) return undefined;
  const text = sanitizeRegistryText(note);
  if (Array.from(text).length > NOTE_MAX) return null;
  return text || undefined;
}

function toResponse(reply: AccessRequestReply): Response {
  const { status, code, message } = reply;
  if (status >= 200 && status < 300) {
    return Response.json({ ok: true, ...(message ? { message } : {}) }, { status: 202 });
  }
  if (status === 404) return Response.json({ error: "requests_not_accepted" }, { status: 404 });
  if (status === 409 && code === "already_granted") {
    return Response.json({ error: "already_granted" }, { status: 409 });
  }
  if (status === 413) return Response.json({ error: "payload_too_large" }, { status: 413 });
  if (status === 429) return Response.json({ error: "rate_limited", ...(message ? { message } : {}) }, { status: 429 });
  if (status === 401 || status === 403) return Response.json({ error: "source_key_invalid" }, { status: 502 });
  return Response.json({ error: "request_failed" }, { status: 502 });
}

export async function POST(req: Request): Promise<Response> {
  const who = await guard(req);
  if (who instanceof Response) return who;

  if (await hitRateLimit(who.userId, { namespace: "registry-request", limit: 5, windowMs: 60_000 })) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = await readBody(req);
  if (body instanceof Response) return body;

  try {
    await assertKnownRegistrySource(body.source);
  } catch (e) {
    if (e instanceof UnknownRegistrySource) {
      return Response.json({ error: "unknown_source" }, { status: 400 });
    }
    throw e;
  }

  const note = cleanNote(body.note);
  if (note === null) return Response.json({ error: "payload_too_large" }, { status: 413 });

  try {
    const reply = await sendAccessRequest(body.source, {
      extension: body.extension,
      ...(note ? { note } : {}),
      ...(body.contact ? { contact: { name: who.name, email: who.email } } : {}),
    });
    return toResponse(reply);
  } catch (e) {
    console.error("[registry-request]", e instanceof Error ? e.message : e);
    return Response.json({ error: "request_failed" }, { status: 502 });
  }
}
