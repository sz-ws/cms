import { getPlainSetting } from "../settings";
import {
  MCP_PATH,
  authorizationServerMetadata,
  corsHeaders,
  disabledResponse,
  isMcpEnabled,
  preflight,
  protectedResourceMetadata,
  resolveMcpOrigin,
} from "./site";

// 兩份 /.well-known 探索文件的處理(route 檔只接線)。
//
// 路徑的變體:RFC 9728 / RFC 8414 規定「resource / issuer 帶路徑時,把路徑接在 well-known
// 後面」。我們的 resource 是 <origin>/api/mcp,所以 protected resource metadata 在
// /.well-known/oauth-protected-resource/api/mcp;issuer 是 origin 本身,authorization server
// metadata 在 /.well-known/oauth-authorization-server。但 client 的實作各有各的猜法(有的
// 拿 MCP 路徑去接 authorization server、有的只探根路徑),所以兩份文件在「根」與「/api/mcp」
// 兩個位置都回答,其餘路徑 404。

const METHODS = "GET, OPTIONS";

export function discoveryPreflight(): Response {
  return preflight(METHODS);
}

function suffixOk(path: string[] | undefined): boolean {
  const suffix = path && path.length > 0 ? `/${path.join("/")}` : "";
  return suffix === "" || suffix === MCP_PATH;
}

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404, headers: corsHeaders(METHODS) });
}

function metadataResponse(body: Record<string, unknown>): Response {
  // no-store:開關一關,文件要立刻說「沒有開放」,不能被快取住。
  return Response.json(body, { headers: { ...corsHeaders(METHODS), "Cache-Control": "no-store" } });
}

export async function protectedResourceDocument(req: Request, path: string[] | undefined): Promise<Response> {
  if (!(await isMcpEnabled())) return disabledResponse(METHODS);
  if (!suffixOk(path)) return notFound();
  const origin = await resolveMcpOrigin(req.url);
  const title = await getPlainSetting<unknown>("core.siteTitle", "");
  return metadataResponse(protectedResourceMetadata(origin, typeof title === "string" ? title.trim() : ""));
}

export async function authorizationServerDocument(req: Request, path: string[] | undefined): Promise<Response> {
  if (!(await isMcpEnabled())) return disabledResponse(METHODS);
  if (!suffixOk(path)) return notFound();
  return metadataResponse(authorizationServerMetadata(await resolveMcpOrigin(req.url)));
}
