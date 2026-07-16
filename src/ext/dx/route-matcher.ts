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
