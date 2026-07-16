// spec-login-providers.md §4:declarative loginProvider button 的品牌 SVG 驗證器。
//
// 設計取捨(同 stylesheet-guard.ts 哲學):採「validate-and-REJECT」而非
// 「sanitize-and-serve」。要「改寫」SVG 使其安全需要一個真正的 XML/SVG parser
// (正確處理 namespace、entity、CDATA、屬性大小寫);自己寫的小 regex 改寫器只會
// 給人「已消毒」的假象,反而更危險。所以這裡只做「整份接受或整份拒絕」——任何
// 命中危險特徵的一律拒絕(manifest 驗證失敗,fail-loud);安裝時驗過,渲染時視為
// 可信(登入頁 dangerouslySetInnerHTML)。
//
// Rationale (English): a sanitizer that rewrites SVG needs a real parser to be
// safe; reject-on-suspicion is the only defensible posture for a lightweight
// guard. The SVG is injected into a trusted admin/login surface, so every known
// SVG script/exfiltration vector must be blocked at validation time.

/** 驗證結果:成功只回 ok;失敗附一段可讀 reason(manifest issue message 用)。 */
export type SvgValidation = { ok: true } | { ok: false; reason: string };

// spec 已定 svg 上限 4000 chars(zod .max(4000));此處以 bytes 再設一道保底
// (UTF-8 可能 > char 數,但 4000 char 遠小於此上限,雙保險)。
const MAX_SVG_BYTES = 16 * 1024;

// 允許的空白控制字元:\t (0x09) \n (0x0A) \r (0x0D)。其餘 C0 控制字元 + DEL
// (0x7F) 一律視為「非文字」而拒絕(含 NUL);U+FFFD 代表非法 UTF-8。
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F�]/;

// XML/HTML 註解 `<!-- ... -->`(non-greedy)。移除時換成單一空白,避免
// `<pa<!-- -->th>` 之類的 token 黏合逃逸。
const COMMENT_RE = /<!--[\s\S]*?-->/g;

// spec §4 allowlist:僅這些標籤合法。任何其他標籤(含 <script>/<foreignObject>/
// <image>/<use>/<style>/<animate*>)一律拒絕。
const ALLOWED_TAGS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "rect",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "title",
]);

// 字面拒絕 token(移除註解後、小寫化比對)。多為冗餘的 defense-in-depth——
// tag allowlist 已擋掉 <script>/<image>/... 標籤,但 scheme / event handler 屬性
// 需另外擋。
const LITERAL_DENY = [
  "javascript:", // scheme(url() 或屬性值內皆擋)
  "<script", // 冗餘(tag allowlist 已擋),保底
  "<foreignobject",
  "<!doctype",
  "<!entity",
  "<![cdata[",
  "&#", // 數值 entity(可藏 javascript:);SVG icon 無需 entity
] as const;

// 所有 tag 名(開頭 tag 與結尾 tag)。抓 `<` 後可選 `/`、再抓 tag 名。
const TAG_RE = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)/g;

// 任意 `on*=` 事件處理屬性(onload / onclick / onbegin …)。屬性名以字母界線
// 起頭,後接 `on` + 至少一字母,直到 `=`(容許中間空白)。
const EVENT_HANDLER_RE = /(^|[\s"'/])on[a-z]+\s*=/i;

// href / xlink:href(可外連或走 javascript:)。SVG icon 一律不需要 —— 直接拒。
const HREF_RE = /(^|[\s"'/])(xlink:)?href\s*=/i;

// url(...) 目標擷取(presentation 屬性如 fill/stroke/clip-path 內的 url() 引用)。
// 容許可選單/雙引號;抓括號內字串交給 isSafeUrlTarget 判定。標準 xmlns 命名空間
// (http://www.w3.org/2000/svg)不是 url() 目標,故不受此檢查影響。
const URL_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * url() 目標安全判定(同 stylesheet-guard 哲學):
 *   - 放行空目標、`data:image/`、fragment(`#id`,如 url(#gradient))、同站相對路徑。
 *   - 任何含 `//`(protocol-relative / https://)或 scheme-qualified 一律拒(外連 =
 *     exfiltration channel)。
 */
function isSafeUrlTarget(raw: string): boolean {
  const v = raw.trim();
  if (v === "") return true;
  if (v.startsWith("#")) return true; // fragment 引用(gradient / clipPath)
  if (v.toLowerCase().startsWith("data:image/")) return true;
  if (v.includes("//")) return false;
  if (SCHEME_RE.test(v)) return false;
  return true;
}

/**
 * 驗證一段 SVG 是否可安全注入受信任的 admin/login 表面。純函式,不改寫、不 throw。
 * 成功 → { ok:true };失敗 → { ok:false, reason }(第一個命中的原因)。
 */
export function validateSvg(svg: string): SvgValidation {
  // 1) 大小上限(bytes)。
  const byteLen = new TextEncoder().encode(svg).length;
  if (byteLen > MAX_SVG_BYTES) {
    return { ok: false, reason: `svg exceeds ${MAX_SVG_BYTES} bytes` };
  }

  // 2) 控制字元 / 非法 UTF-8(允許 \n \r \t)。在「原始」文字上檢查。
  if (CONTROL_CHAR_RE.test(svg)) {
    return { ok: false, reason: "svg contains control characters" };
  }

  // 3) 移除註解(換單一空白),之後所有比對都在此版本上做。
  const stripped = svg.replace(COMMENT_RE, " ");
  const lower = stripped.toLowerCase();

  // 4) 必須是 SVG 片段:含一個 <svg 根。
  if (!/<\s*svg[\s>]/i.test(stripped)) {
    return { ok: false, reason: "svg must contain an <svg> root element" };
  }

  // 5) 字面拒絕 token(case-insensitive)。
  for (const token of LITERAL_DENY) {
    if (lower.includes(token)) {
      return { ok: false, reason: `svg contains forbidden token: ${token}` };
    }
  }

  // 6) 事件處理屬性 / href / xlink:href。
  if (EVENT_HANDLER_RE.test(stripped)) {
    return { ok: false, reason: "svg contains a forbidden on*= event handler" };
  }
  if (HREF_RE.test(stripped)) {
    return { ok: false, reason: "svg contains a forbidden href/xlink:href attribute" };
  }

  // 7) url() 目標:只允許 fragment / data:image/ / 同站相對(外連 url() 一律拒)。
  for (const match of stripped.matchAll(URL_RE)) {
    const target = match[2] ?? "";
    if (!isSafeUrlTarget(target)) {
      return {
        ok: false,
        reason: `svg contains an external url() target: ${target.trim()}`,
      };
    }
  }

  // 8) 標籤 allowlist:每個 tag 名(開頭或結尾)都必須在白名單內。
  for (const match of stripped.matchAll(TAG_RE)) {
    const tag = match[2].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      return { ok: false, reason: `svg contains a forbidden tag: <${tag}>` };
    }
  }

  return { ok: true };
}
