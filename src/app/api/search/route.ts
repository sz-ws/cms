import { requireAuth, authErrorResponse, getSessionAccess } from "@/lib/auth";
import { atLeast, levelOf, type AccessMap } from "@/ext/admin-access";
import { hitRateLimit } from "@/lib/rate-limit";
import {
  searchContent,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MIN_QUERY_LENGTH,
} from "@/lib/search";
import { listDeclarativeTypes } from "@/ext/dx/type-directory";
import { getLocale } from "@/lib/i18n/server";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import { getDB } from "@/lib/cf";
import {
  activeSearchSources,
  searchRecordSources,
  type RecordSearchHit,
} from "@/ext/search-sources";

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

  // 1.50.0:自訂角色只搜得到它看得到的頁 —— 內容看該 type 的列表頁,插件紀錄看宣告
  // 來源的那一頁(檢視以上)。這條 API 沒有門,所以 user.role 對自訂角色永遠是 editor。
  const access = user.staffRole ? ((await getSessionAccess())?.access ?? {}) : null;
  const canSee = (href: string | undefined) =>
    access === null || (href !== undefined && atLeast(levelOf(access, href), "view"));

  const locale = await getLocale();
  // 1.40.0:extension 宣告的資料表來源(訂單、客戶…)只給 admin,與全文索引並行查。
  const [results, records] = await Promise.all([
    searchContent(q, limit),
    (user.role === "admin" || access !== null) && q.length >= MIN_QUERY_LENGTH
      ? searchRecords(q, locale, access)
      : Promise.resolve([]),
  ]);

  // 補 editHref / typeLabel:manifest 的 admin slug 只有 server 知道(同 dashboard
  // aggregate 的 discovery)。查無對應 type(如 extension 已停用)→ editHref null,
  // 前端呈現為不可點的列。
  const types = await listDeclarativeTypes(locale);
  const byKey = new Map(types.map((t) => [t.typeKey, t]));
  const visible = results.filter((r) => canSee(byKey.get(r.typeKey)?.collectionHref));
  const enriched = visible.map((r) => {
    const t = byKey.get(r.typeKey);
    return {
      ...r,
      typeLabel: t?.typeLabel ?? r.typeKey,
      editHref: t
        ? `${t.collectionHref}/edit?id=${encodeURIComponent(r.id)}`
        : null,
    };
  });
  return Response.json({ results: [...records, ...enriched] });
}

/**
 * extension 來源的搜尋。loader 用到才載入(它會帶進整個 extension registry,
 * 非 admin 與短查詢不必付這個成本);任何失敗都只讓這一段變空,內容搜尋照常回。
 */
async function searchRecords(
  q: string,
  locale: Awaited<ReturnType<typeof getLocale>>,
  access: AccessMap | null,
): Promise<RecordSearchHit[]> {
  try {
    const { getExtRuntime } = await import("@/ext/loader");
    const rt = await getExtRuntime();
    const sources = activeSearchSources(rt.enabled).filter(
      (source) => access === null || atLeast(levelOf(access, source.pageHref), "view"),
    );
    if (sources.length === 0) return [];
    return await searchRecordSources(
      getDB(),
      sources,
      q,
      (value) => resolveLocalizedString(value, locale) ?? "",
    );
  } catch (error) {
    console.error("[search] extension sources failed", error);
    return [];
  }
}
