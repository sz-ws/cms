import { discoveryPreflight, protectedResourceDocument } from "@/lib/mcp/discovery";

// AI 連線:RFC 9728 protected resource metadata。根路徑與 /api/mcp 後綴都回答
// (見 lib/mcp/discovery.ts);AI 開關關著時回 404。

export function OPTIONS(): Response {
  return discoveryPreflight();
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  return protectedResourceDocument(req, (await ctx.params).path);
}
