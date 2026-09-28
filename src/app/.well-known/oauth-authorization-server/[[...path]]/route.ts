import { authorizationServerDocument, discoveryPreflight } from "@/lib/mcp/discovery";

// AI 連線:RFC 8414 authorization server metadata。issuer 是站台 origin;/api/mcp 後綴也
// 回答同一份(見 lib/mcp/discovery.ts)。AI 開關關著時回 404。

export function OPTIONS(): Response {
  return discoveryPreflight();
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  return authorizationServerDocument(req, (await ctx.params).path);
}
