// core-v2 §3.2 / §5:route pattern → segment matcher。純字串段比較,O(segments),
// 無 regex(ReDoS 面)、無 I/O。pattern 形如 "/gallery" 或 "/gallery/:slug"。

export type PatternSegment = { literal: string } | { param: string };

/** 把 "/gallery/:slug" 拆成段模板陣列(literal 或 param)。前導 "/" 去除。 */
export function compilePattern(
  pattern: string,
): PatternSegment[] {
  return pattern
    .split("/")
    .filter((s) => s.length > 0)
    .map((seg) =>
      seg.startsWith(":") ? { param: seg.slice(1) } : { literal: seg },
    );
}

/** 對輸入 segments 做匹配;成功回傳 params,失敗回 null。 */
export function matchSegments(
  template: PatternSegment[],
  segments: string[],
): Record<string, string> | null {
  if (template.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < template.length; i++) {
    const t = template[i];
    const s = segments[i];
    if ("literal" in t) {
      if (t.literal !== s) return null;
    } else {
      params[t.param] = s;
    }
  }
  return params;
}

/**
 * URL 路徑段 → 解碼後的字串(每段只解一次)。任一段是壞掉的 `%` 序列 → null,呼叫端
 * 一律當 404 —— decodeURIComponent 對 `%E6%98`、`%zz` 會丟 URIError,不接住就是一個
 * 誰都打得出來的 500。
 *
 * 為何要自己解:中文 slug 的請求進來時是 percent-encoded,而 Next 16 App Router 交給
 * page 的 params **是編碼過的**(next/dist/shared/lib/router/utils/get-dynamic-param.js
 * 會對每一段 encodeURIComponent),route handler 拿到的則已解碼。slug 規則(./slug.ts)
 * 不會產生 `%`,所以對已解碼的值再解一次原樣不動,兩種來源都對得上 contents.slug。
 */
export function decodePathSegments(
  segments: readonly string[],
): string[] | null {
  const out: string[] = [];
  for (const segment of segments) {
    try {
      out.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  return out;
}

/**
 * detail 頁網址 `<base>/<slug>`,slug 以 encodeURIComponent 編碼。sitemap / RSS 的
 * `<loc>`、`<link>` 必須是合法 URL(不能夾原始的中日韓字元),href 編碼了一樣能用,
 * 所以組 detail 連結的地方都走這支,不各自拼字串。base 來自 manifest publicRoutes 的
 * pattern,字面段只允許 [a-z0-9-](manifest.ts ROUTE_PATTERN_RE),不必編碼;
 * pattern 是 "/:slug" 時 base 為 "/",去掉結尾斜線才不會拼出 "//slug"
 * (瀏覽器會把它當成 protocol-relative URL,連到名為 slug 的主機)。
 */
export function detailPath(base: string, slug: string): string {
  const prefix = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${prefix}/${encodeURIComponent(slug)}`;
}
