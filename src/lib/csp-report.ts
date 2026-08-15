// [core] CSP 違規回報的**正規化**。純函式,不碰網路也不碰 D1 —— route 那邊只
// 負責限流、讀 body、把這裡的產物送給錯誤回報層。
//
// ## 為什麼要正規化,不直接把 body 轉送出去
//
// 兩個理由,而且第二個比較重要:
//
// 1. **格式有兩種**。舊的 `report-uri` 送 `application/csp-report`,單一物件、
//    kebab-case 欄位;新的 Reporting API 送 `application/reports+json`,**陣列**、
//    camelCase 欄位。兩邊的欄位名沒有一個對得上,呼叫端不該關心是哪一種。
// 2. **原始回報帶著會外洩的東西**。`document-uri` 是完整網址 —— 後台的路徑含內容
//    id(這正是本 repo 把 Referrer-Policy 設成 strict-origin-when-cross-origin 的
//    理由),而錯誤追蹤系統的存取控制永遠比正式資料庫鬆。所以這裡只留**路徑**、
//    丟掉 query 與 host;`blocked-uri` 只留 origin,丟掉路徑。
//
// 回報也是不可信輸入:任何人都能對這個端點 POST 任意 JSON。所有欄位一律當成
// `unknown` 讀、截斷長度、缺就給預設值,**絕不 throw**。

/** 一筆正規化後的違規。所有欄位都是短字串,可以直接當 tag 用。 */
export interface CspViolation {
  /** 被擋的指令,例 `script-src-elem`。讀不到時 "unknown"。 */
  directive: string;
  /** 觸發來源:關鍵字(inline / eval / wasm-eval)原樣;網址只留 origin。 */
  blocked: string;
  /** 發生的頁面路徑。**不含** host 與 query。 */
  documentPath: string;
  /** Report-Only 收到的是 "report";policy 改 enforce 之後才會出現 "enforce"。 */
  disposition: "report" | "enforce";
}

/** 單次 payload 最多收幾筆。Reporting API 會把多筆打包成一個陣列。 */
export const CSP_REPORT_MAX_ITEMS = 10;

/** 每個欄位的長度上限。tag 不是拿來裝內容的。 */
const FIELD_MAX = 120;

function str(value: unknown): string {
  return typeof value === "string" ? value.slice(0, FIELD_MAX) : "";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * `blocked-uri` 的值可能是關鍵字,也可能是完整網址。
 *
 * 關鍵字(inline / eval / wasm-eval / data / blob …)本身就是答案,原樣留著 ——
 * 尤其 `wasm-eval`,那是 QuickJS 沙盒需要 `'wasm-unsafe-eval'` 的直接證據。
 * 網址則只留 origin:知道「是哪個第三方」就夠了,路徑與 query 可能帶查詢字串。
 */
function normalizeBlocked(raw: unknown): string {
  const value = str(raw).trim();
  if (!value) return "unknown";
  if (!value.includes("://")) return value;
  try {
    return new URL(value).origin;
  } catch {
    return "unknown";
  }
}

/** 只留路徑。相對路徑原樣、絕對網址取 pathname、讀不到給 "/"。 */
function normalizeDocumentPath(raw: unknown): string {
  const value = str(raw).trim();
  if (!value) return "/";
  if (!value.includes("://")) return value.split("?")[0] || "/";
  try {
    return new URL(value).pathname || "/";
  } catch {
    return "/";
  }
}

function normalizeDisposition(raw: unknown): "report" | "enforce" {
  // 預設 "report":現行 policy 就是 Report-Only,而把 enforce 誤標成 report 會讓
  // 「使用者真的被擋了」看起來像演習。反過來偏保守才安全。
  return str(raw).trim() === "enforce" ? "enforce" : "report";
}

/** 舊格式:`{ "csp-report": { "effective-directive": …, "blocked-uri": … } }` */
function fromLegacy(body: Record<string, unknown>): CspViolation | null {
  const r = record(body["csp-report"]);
  if (!r) return null;
  // effective-directive 是實際生效的那一個(例 script-src-elem);violated-directive
  // 是舊欄位,帶著整段值。前者不存在時才退回後者,並只取第一個 token。
  const directive =
    str(r["effective-directive"]).trim() ||
    str(r["violated-directive"]).trim().split(/\s+/)[0] ||
    "unknown";
  return {
    directive,
    blocked: normalizeBlocked(r["blocked-uri"]),
    documentPath: normalizeDocumentPath(r["document-uri"]),
    disposition: normalizeDisposition(r["disposition"]),
  };
}

/** 新格式:`[{ type: "csp-violation", body: { effectiveDirective, blockedURL } }]` */
function fromReportingApi(entry: unknown): CspViolation | null {
  const e = record(entry);
  if (!e) return null;
  // 同一個端點可能收到別種 report(deprecation、intervention)。只收 CSP 那種 ——
  // 其餘安靜丟掉,不要把不相干的東西當違規報上去。
  if (str(e["type"]).trim() !== "csp-violation") return null;
  const b = record(e["body"]);
  if (!b) return null;
  return {
    directive: str(b["effectiveDirective"]).trim() || "unknown",
    blocked: normalizeBlocked(b["blockedURL"]),
    documentPath: normalizeDocumentPath(b["documentURL"] ?? e["url"]),
    disposition: normalizeDisposition(b["disposition"]),
  };
}

/**
 * 把任何一種 payload 轉成違規清單。認不出來就回空陣列(呼叫端據此回 400)。
 */
export function normalizeCspReports(parsed: unknown): CspViolation[] {
  if (Array.isArray(parsed)) {
    return parsed
      .slice(0, CSP_REPORT_MAX_ITEMS)
      .map(fromReportingApi)
      .filter((v): v is CspViolation => v !== null);
  }
  const body = record(parsed);
  if (!body) return [];
  const legacy = fromLegacy(body);
  return legacy ? [legacy] : [];
}

/** 給錯誤回報層看的一行摘要。刻意不含 host、query、原始 policy。 */
export function describeCspViolation(v: CspViolation): string {
  return `CSP ${v.disposition}: ${v.directive} blocked ${v.blocked} on ${v.documentPath}`;
}
