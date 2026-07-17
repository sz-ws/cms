import { requireAuth, authErrorResponse } from "@/lib/auth";
import { hitRateLimit } from "@/lib/rate-limit";
import {
  searchContent,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
} from "@/lib/search";
import { listDeclarativeTypes } from "@/ext/dx/type-directory";
import { getLocale } from "@/lib/i18n/server";

// Admin full-text search:GET /api/search?q=...&limit=...
// 任何已登入角色皆可用(NOT admin-only)。GET 無狀態變更,故不需 assertSameOrigin。
// q 由 searchContent 內部淨化為安全的 FTS5 MATCH(見 src/lib/search.ts buildMatchQuery)。
// 每使用者速率限制,沿用既有 hitRateLimit(login_attempts 計數表)。

const RATE_LIMIT = 60; // 每窗口最多次數
const RATE_WINDOW_MS = 60_000; // 1 分鐘

export async function GET(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireAuth(); // 任何已登入角色
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  const limited = await hitRateLimit(user.id, {
    namespace: "search",
    limit: RATE_LIMIT,
    windowMs: RATE_WINDOW_MS,
  });
  if (limited) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();

  // limit:非法/未帶 → 預設;超過上限由 searchContent 內再夾一次,此處先 clamp。
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(1, rawLimit), MAX_SEARCH_LIMIT)
    : DEFAULT_SEARCH_LIMIT;

  const results = await searchContent(q, limit);

  // 補 editHref / typeLabel:manifest 的 admin slug 只有 server 知道(同 dashboard
  // aggregate 的 discovery)。查無對應 type(如 extension 已停用)→ editHref null,
  // 前端呈現為不可點的列。
  const types = await listDeclarativeTypes(await getLocale());
  const byKey = new Map(types.map((t) => [t.typeKey, t]));
  const enriched = results.map((r) => {
    const t = byKey.get(r.typeKey);
    return {
      ...r,
      typeLabel: t?.typeLabel ?? r.typeKey,
      editHref: t
        ? `${t.collectionHref}/edit?id=${encodeURIComponent(r.id)}`
        : null,
    };
  });
  return Response.json({ results: enriched });
}
