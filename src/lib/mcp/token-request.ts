import { declaredLengthExceeds, readBoundedText } from "../body-limit";

// token / revoke 端點共用的請求解析:form 或 JSON body + client 認證(RFC 6749 §2.3.1)。
// 純函式(除了讀 body),測試直接餵 Request。

export type TokenParams = Record<string, string>;

export type ParsedTokenRequest =
  | { ok: true; params: TokenParams; clientId: string | null; clientSecret: string | null }
  | { ok: false; reason: "too_large" | "invalid" };

/**
 * body 照規格是 application/x-www-form-urlencoded;有些 client 送 JSON,一樣收。
 * 同一個參數出現兩次 = 不合法(RFC 6749 §3.2)。只收字串值。
 */
async function readParams(req: Request, maxBytes: number): Promise<TokenParams | "too_large" | null> {
  if (declaredLengthExceeds(req, maxBytes)) return "too_large";
  const text = await readBoundedText(req, maxBytes, "mcp-token");
  if (text === null) return "too_large";
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  const out: TokenParams = {};
  if (type.includes("application/json")) {
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return null;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string") out[key] = v;
    }
    return out;
  }
  const form = new URLSearchParams(text);
  for (const key of new Set(form.keys())) {
    const all = form.getAll(key);
    if (all.length !== 1) return null;
    out[key] = all[0];
  }
  return out;
}

/** Authorization: Basic base64(urlencode(id):urlencode(secret))。格式不對回 null。 */
function basicCredentials(header: string | null): { id: string; secret: string } | null {
  if (!header) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header.trim());
  if (!match) return null;
  let decoded: string;
  try {
    decoded = atob(match[1]);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon <= 0) return null;
  try {
    return {
      id: decodeURIComponent(decoded.slice(0, colon)),
      secret: decodeURIComponent(decoded.slice(colon + 1)),
    };
  } catch {
    return null;
  }
}

export async function parseTokenRequest(req: Request, maxBytes: number): Promise<ParsedTokenRequest> {
  const params = await readParams(req, maxBytes);
  if (params === "too_large") return { ok: false, reason: "too_large" };
  if (params === null) return { ok: false, reason: "invalid" };
  const basic = basicCredentials(req.headers.get("authorization"));
  // 兩處都帶 client_id 而且不一樣 = 不合法。secret 以 Basic 為準(規格建議的那一種)。
  if (basic && params.client_id && params.client_id !== basic.id) return { ok: false, reason: "invalid" };
  return {
    ok: true,
    params,
    clientId: basic?.id ?? params.client_id ?? null,
    clientSecret: basic?.secret ?? params.client_secret ?? null,
  };
}
