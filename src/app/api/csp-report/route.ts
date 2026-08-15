import { readBoundedText } from "@/lib/body-limit";
import { hitRateLimit } from "@/lib/rate-limit";
import {
  describeCspViolation,
  normalizeCspReports,
  type CspViolation,
} from "@/lib/csp-report";
import { reportError } from "@/lib/observe/report";

// [core] CSP 違規的收件端點。next.config.ts 的 policy 以 `report-uri /api/csp-report`
// 指到這裡。
//
// ## 為什麼需要它
//
// 這個站的 CSP 是 **Report-Only**,而 Report-Only 若沒有收件端點,違規只會出現在
// 「剛好打開 devtools 的那個人」的 console 裡 —— 等於沒開。而升級成 enforce 的
// 前提正是「先確定真實流量上沒有東西會被擋」,那份資料只能從真實使用者身上收。
//
// ## 這個端點的四條紀律
//
// 1. **公開、不認證**。瀏覽器送違規報告時不帶 cookie,也不會先登入。要求認證等於
//    只收得到零筆。
// 2. **不落庫**。任何人都能對它 POST,寫 D1 等於給了一個免費的寫入放大器(而 D1
//    的 Free plan 天花板是 500MB)。轉給錯誤回報層,那邊本來就有配額與去重。
// 3. **限流 + body 上限**。同上,這是一個公開寫入面。
// 4. **絕不 throw、永遠回 204**。瀏覽器不看回應也不重試;這個端點自己壞掉不該
//    變成另一個錯誤來源。狀態碼只對「拿 curl 在調試的人」有意義。
//
// ⚠️ 注意這裡回報的是**違規**,不是例外。reportError 收 unknown,所以包成 Error
// 送 —— 訊息與 tag 都只帶已經正規化過的短字串(見 lib/csp-report.ts 的說明:
// 原始回報的 document-uri 含後台路徑,而後台路徑含內容 id)。

/** 一次 payload 的上限。原始回報會帶整段 original-policy,所以不能設太小。 */
const MAX_BODY_BYTES = 16_384;

/** 每個 IP 的視窗與額度。單頁多個不同指令的違規會分開送,所以留寬一點。 */
const REPORT_LIMIT = 30;
const REPORT_WINDOW_MS = 5 * 60_000;

/** 這兩種 content-type 是規範定義的;其餘一律拒收,不當通用垃圾桶。 */
const ACCEPTED_TYPES = [
  "application/csp-report",
  "application/reports+json",
  "application/json",
];

function accepted(req: Request): boolean {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  return ACCEPTED_TYPES.some((t) => ct.includes(t));
}

async function forward(violations: CspViolation[]): Promise<void> {
  for (const v of violations) {
    const line = describeCspViolation(v);
    // console 這一份是給 `wrangler tail` 看的 —— 沒設 DSN 的站(新 clone 的預設
    // 狀態)只有這一條路看得到違規。
    console.error(`[csp] ${line}`);
    await reportError(new Error(line), {
      kind: "csp-violation",
      directive: v.directive,
      blocked: v.blocked,
      disposition: v.disposition,
    });
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    if (!accepted(req)) return new Response(null, { status: 415 });

    const ip = req.headers.get("cf-connecting-ip") ?? "local";
    const blocked = await hitRateLimit(ip, {
      namespace: "csp-report",
      limit: REPORT_LIMIT,
      windowMs: REPORT_WINDOW_MS,
    });
    if (blocked) return new Response(null, { status: 429 });

    // 不用 readBoundedJsonObject:Reporting API 送的是**陣列**,而那支會把陣列
    // 判成 invalid。這裡自己 parse,兩種形狀都交給 normalizeCspReports 認。
    const text = await readBoundedText(req, MAX_BODY_BYTES, "csp-report");
    if (text === null) return new Response(null, { status: 413 });

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return new Response(null, { status: 400 });
    }

    const violations = normalizeCspReports(parsed);
    if (violations.length === 0) return new Response(null, { status: 400 });

    await forward(violations);
    return new Response(null, { status: 204 });
  } catch (e) {
    // 監控是旁觀者。這支自己炸了就安靜認了 —— 讓瀏覽器因為回報端點 500 而重試,
    // 是把一個「有東西被擋」的訊號變成一場流量事故。
    console.error("[csp] failed to accept a violation report", e);
    return new Response(null, { status: 204 });
  }
}
