import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { getExtRuntime } from "@/ext/loader";
import { createServices } from "@/ext/services";
import type { ApiRoute } from "@/ext/types";

// 03 §6b:Extension API dispatch。Next.js 15 簽名:params 是 Promise,要 await。

// core 提供的匹配演算法(extension 不自己寫 matcher)。「先註冊先贏」。
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function matchApiRoute(
  routes: ApiRoute[],
  method: string,
  segments: string[],
): { route: ApiRoute; params: Record<string, string> } | null {
  for (const r of routes) {
    if (r.method !== method) continue;
    const pat = r.path.split("/");
    if (pat.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pat.length; i++) {
      if (pat[i].startsWith(":"))
        params[pat[i].slice(1)] = decodeURIComponent(segments[i]);
      else if (pat[i] !== segments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route: r, params }; // 先註冊先贏
  }
  return null;
}

async function dispatch(
  req: Request,
  ctx: { params: Promise<{ extId: string; path?: string[] }> },
): Promise<Response> {
  // 04 §5:所有以 cookie session 認證的 mutation API 必須做 Origin 檢查。
  // 即使 extension 宣告 public(免登入),Origin 仍要擋(匿名外部 POST 必須同源)。
  if (MUTATION_METHODS.has(req.method)) {
    try {
      assertSameOrigin(req);
    } catch (e) {
      const r = originErrorResponse(e);
      if (r) return r;
      throw e;
    }
  }

  // 1. resolve runtime 先判斷是否走 public path(免 requireAuth)。
  const { extId, path } = await ctx.params;
  const rt = await getExtRuntime();
  const ext = rt.byId(extId);
  if (!ext) return Response.json({ error: "not_found" }, { status: 404 });

  // core-v2 §2.4 升級(Alpha):declarative content type 可宣告 public:true,免登入。
  // 觸發條件:POST + path[0] 對應某個 content type 且該 type 標 public。
  // (GET/PUT/DELETE 仍需 auth —— public 只放寬「匿名建立新 content」這一個動詞。)
  let user: Awaited<ReturnType<typeof requireAuth>> | null = null;
  const segments = path ?? [];
  const matched = matchApiRoute(ext.apiRoutes ?? [], req.method, segments);
  if (!matched) return Response.json({ error: "not_found" }, { status: 404 });

  const routePathFirst = segments[0] ?? "";
  const isPublicPost =
    req.method === "POST" &&
    matched.route.path === routePathFirst &&
    ext.contentTypes?.some(
      (c) => c.name === routePathFirst && c.public === true,
    ) === true;

  if (!isPublicPost) {
    // 預設路徑:requireAuth(編輯者及以上)。
    try {
      user = await requireAuth();
    } catch (e) {
      const r = authErrorResponse(e);
      if (r) return r;
      throw e;
    }
  }

  // core-v2 §2.1:建立 scope=extId 的 CoreServices,連同 user 組成 ctx。
  const services = await createServices(extId);
  // 公開寫入路徑:用 placeholder anonymous user(ContentEntry 沒有 createdBy 欄位,
  // user 主要是給 plugin/scope 隔離;後續若要記錄提交者再加 createdBy)。
  const ctxUser = user ?? {
    id: "anonymous",
    email: "anonymous@public",
    name: "Anonymous",
    role: "editor" as const,
    avatarKey: null,
  };
  return matched.route.handler(req, matched.params, { user: ctxUser, services });
}

export const GET = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
