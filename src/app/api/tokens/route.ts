import { z } from "zod";
import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { createApiToken, listApiTokens } from "@/lib/api-token";

// roadmap #1 §5:API Tokens admin CRUD。這些是 cookie session 的 admin 操作
// (mirror Registry Sources 模式),故 mutation 要 Origin 檢查 —— 與公開 bearer
// 端點(/api/content,無 Origin)相反。

// GET /api/tokens:列出 tokens(絕不含 raw / hash)。
export async function GET(): Promise<Response> {
  try {
    await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }
  const tokens = await listApiTokens();
  return Response.json({ tokens });
}

const createSchema = z.object({ name: z.string().min(1).max(120) }).strict();

// POST /api/tokens:建立 token。回應含 raw token —— 只此一次(之後永不可再看到)。
export async function POST(req: Request): Promise<Response> {
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

  let parsed: z.infer<typeof createSchema>;
  try {
    parsed = createSchema.parse(await req.json());
  } catch {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  const created = await createApiToken(parsed.name.trim());
  // raw 只在此回應出現一次;UI 需明顯顯示 + 警語「離開後無法再看到」。
  return Response.json({
    id: created.id,
    prefix: created.prefix,
    raw: created.raw,
  });
}
