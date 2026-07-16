// 1.8.0:declarative extension 的 co-located `style.css` 驗證器。
//
// 設計取捨(Traditional Chinese rationale):此 guard 採「validate-and-REJECT」而
// 「非 strip-and-serve」。理由:要「改寫」CSS 使其安全,需要一個真正的 CSS parser
// (正確處理字串、跳脫、巢狀、at-rule),自己寫一個小 regex 改寫器只會給人「已消毒」
// 的假象,反而更危險。所以這裡只做「整份接受或整份拒絕」——任何命中危險特徵的一律
// 拒絕安裝(install route 在寫 DB 前 fail fast),絕不試圖修補後照樣上線。
// Rationale (English): a sanitizer that rewrites CSS needs a real parser to be safe;
// reject-on-suspicion is the only defensible posture for a lightweight guard.
//
// 這段 CSS 會被以 CSS nesting 包進 `[data-ext="<id>"] { <sheet> }` 後,server-side
// 注入該 extension public 頁面的 <style> —— 與網站同源執行,故所有已知的 CSS 外洩 /
// 逃逸向量都必須擋在安裝時。

/** 驗證結果:成功只回 ok;失敗附一段可讀 reason(install route 轉成 400 message)。 */
export type StylesheetValidation = { ok: true } | { ok: false; reason: string };

// 64KB 上限(bytes,非字元數)。fetch 端另有 1MB cap,但 stylesheet 應遠小於此。
const MAX_STYLESHEET_BYTES = 64 * 1024;

// 允許的空白控制字元:\t (0x09) \n (0x0A) \r (0x0D)。其餘 C0 控制字元 + DEL (0x7F)
// 一律視為「非文字」而拒絕(含 NUL);U+FFFD 代表 fetch 解碼時遇到非法 UTF-8 bytes。
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F�]/;

// CSS 註解 `/* ... */`(non-greedy)。移除時「換成空字串」而非空白 —— 這樣
// `@im/**/port` 會黏回 `@import` 而被下方 token 檢查抓到(spec §3 明列此攻擊)。
const CSS_COMMENT_RE = /\/\*[\s\S]*?\*\//g;

// 移除註解後、以「原樣 + 小寫」兩份比對危險 token。多數為字面子字串;少數容許
// 中間夾空白的向量(expression ( / behavior :)以 regex 涵蓋。
const LITERAL_DENY = [
  "@import", // 外部載入 → 可帶第三方 URL,exfiltration/追蹤
  "@charset", // 影響解析語意
  "@namespace", // 少用且可作為解析面
  "-moz-binding", // XBL binding → 舊 Firefox 任意腳本執行
  "javascript:", // scheme(url() 外也一律擋)
  "</", // </style> 之類的 style-tag breakout(注入即靠此擋 HTML 逃逸)
  "<!--", // HTML 註解 breakout
] as const;

// 夾空白變體:expression( 與 behavior:(IE 時代的任意運算式 / behavior 掛載)。
const EXPRESSION_RE = /expression\s*\(/i;
const BEHAVIOR_RE = /behavior\s*:/i;

// url(...) 目標擷取:容許可選單/雙引號;抓到括號內字串,交給 isSafeUrlTarget 判定。
const URL_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

// scheme 前綴(http: https: blob: data: 之類)。data:image/ 另行放行,其餘 scheme 一律拒。
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * url() 目標安全判定:
 *   - 只放行 `data:image/`(inline 圖)與「同站相對路徑」(以 `/` 起頭或無 scheme)。
 *   - 任何含 `//` 的一律拒(protocol-relative `//evil` 與 `https://evil` 都中);
 *   - 任何 scheme-qualified(http: https: blob: data:(非 image) javascript: …)一律拒。
 * 第三方 URL 是 exfiltration channel(背景圖回連可洩漏 IP / 存在性),故從嚴。
 */
function isSafeUrlTarget(raw: string): boolean {
  const v = raw.trim();
  if (v === "") return true; // url() 空目標:無害
  if (v.toLowerCase().startsWith("data:image/")) return true;
  if (v.includes("//")) return false; // https:// 或 //host 皆含 "//"
  if (SCHEME_RE.test(v)) return false; // 其餘任何 scheme(含 data:(非 image)、blob:)
  return true; // 走到這:無 scheme、無 "//" → 相對路徑或 /abs 路徑,同站
}

/** 花括號平衡:深度計數器,任何時刻不得為負,結尾須歸零。防止逃出 scoping wrapper。 */
function bracesBalanced(css: string): boolean {
  let depth = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/**
 * 驗證一段自訂 CSS 是否可安全注入 extension public 頁面。純函式,不改寫、不 throw。
 * 成功 → { ok:true };失敗 → { ok:false, reason }(第一個命中的原因)。
 */
export function validateStylesheet(css: string): StylesheetValidation {
  // 1) 大小上限(bytes)。
  const byteLen = new TextEncoder().encode(css).length;
  if (byteLen > MAX_STYLESHEET_BYTES) {
    return { ok: false, reason: `stylesheet exceeds ${MAX_STYLESHEET_BYTES} bytes` };
  }

  // 2) 控制字元 / 非法 UTF-8(允許 \n \r \t)。在「原始」文字上檢查。
  if (CONTROL_CHAR_RE.test(css)) {
    return { ok: false, reason: "stylesheet contains control characters" };
  }

  // 3) 先移除註解(換空字串,見上方 CSS_COMMENT_RE 註解),之後所有比對都在此版本上做。
  const stripped = css.replace(CSS_COMMENT_RE, "");
  const lower = stripped.toLowerCase();

  // 4) 危險 token(case-insensitive)。
  for (const token of LITERAL_DENY) {
    if (lower.includes(token)) {
      return { ok: false, reason: `stylesheet contains forbidden token: ${token}` };
    }
  }
  if (EXPRESSION_RE.test(stripped)) {
    return { ok: false, reason: "stylesheet contains forbidden token: expression(" };
  }
  if (BEHAVIOR_RE.test(stripped)) {
    return { ok: false, reason: "stylesheet contains forbidden token: behavior:" };
  }

  // 5) url() 目標:只允許 data:image/ 與同站相對路徑。
  for (const match of stripped.matchAll(URL_RE)) {
    const target = match[2] ?? "";
    if (!isSafeUrlTarget(target)) {
      return {
        ok: false,
        reason: `stylesheet contains disallowed url() target: ${target.trim()}`,
      };
    }
  }

  // 6) 花括號平衡(防逃出 [data-ext] scoping wrapper)。
  if (!bracesBalanced(stripped)) {
    return { ok: false, reason: "stylesheet has unbalanced braces" };
  }

  return { ok: true };
}
