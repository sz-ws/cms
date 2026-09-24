import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare/cloudflare-context";
import {
  createNonce,
  enforcedPublicPolicy,
  isFilePath,
  isPublicPagePath,
  reportOnlyPolicy,
  type PublicPolicyInput,
} from "@/lib/csp";
import { cachedApprovedScriptHosts } from "@/lib/public-csp";
import { PUBLIC_PAGE_HEADER, PUBLIC_PAGE_VALUE, kvTargetFrom, type KvTarget } from "@/lib/stamps";

// 三件事,都要在渲染之前決定:
//   1. /admin:廉價的 cookie 存在性檢查(04 §4),真正驗證在 layout / handler(不查 D1)。
//   2. 公開頁(1.50.0):每個請求一個 nonce,enforce 的 CSP 與完整的 Report-Only。
//      policy 的組法與理由見 @/lib/csp;主機白名單見 @/lib/public-csp。
//   3. 綁了 CMS_KV 的站:公開頁 GET 蓋上 PUBLIC_PAGE_HEADER,頁面據此改從 KV 拿版本戳
//      (@/lib/stamps)。其他路徑一律把瀏覽器自己帶來的這個標頭刪掉 —— 後台、登入、
//      server action 都要讀 D1 的戳(改東西的人要讀到自己剛寫的)。
//
// matcher 放寬到「除了 /api 與 Next 靜態檔以外全部」,路徑分流在下面做 —— 登入、首次
// 設定照舊原樣放行(它們的 Report-Only 由 next.config.ts 送)。
export const config = { matcher: ["/((?!api/|_next/).*)"] };

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return adminGate(req);
  if (isPublicPagePath(pathname)) return publicPage(req);
  if (isFilePath(pathname)) return fileResponse(req);
  return passThrough(req);
}

/**
 * 原樣放行。瀏覽器自己帶了 PUBLIC_PAGE_HEADER 才改寫請求標頭把它刪掉;沒帶(正常的
 * 請求)就與以前一字不差,不多產生任何標頭。
 */
function passThrough(req: NextRequest) {
  if (!req.headers.has(PUBLIC_PAGE_HEADER)) return NextResponse.next();
  const headers = new Headers(req.headers);
  headers.delete(PUBLIC_PAGE_HEADER);
  return NextResponse.next({ request: { headers } });
}

/**
 * robots.txt、sitemap.xml、icon.svg 這類檔案:不在 next.config 的 Report-Only 路徑裡,
 * 也不是公開頁,由這裡補上後台那一份 Report-Only(不用 nonce、不查 D1)。
 */
function fileResponse(req: NextRequest) {
  const res = passThrough(req);
  res.headers.set("Content-Security-Policy-Report-Only", reportOnlyPolicy());
  return res;
}

function adminGate(req: NextRequest) {
  const hasCookie = req.cookies.has("session");
  if (!hasCookie) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(req.nextUrl.pathname)}`;
    return NextResponse.redirect(url);
  }
  // spec-login-providers.md §3:把當前 pathname 透過 request header 傳給 admin
  // layout(Server Component 無法直接拿 pathname),讓 guest gate 能判斷路徑。
  const headers = new Headers(req.headers);
  headers.set("x-pathname", req.nextUrl.pathname);
  headers.delete(PUBLIC_PAGE_HEADER);
  return NextResponse.next({ request: { headers } });
}

/**
 * 請求標頭一律先清掉:Next 從**請求**的 CSP 標頭抓 nonce,scripts-widget 讀 x-nonce,
 * 頁面讀 PUBLIC_PAGE_HEADER 決定戳從哪裡拿,三個都不能讓瀏覽器自己帶進來。
 */
function cleanRequestHeaders(req: NextRequest): Headers {
  const headers = new Headers(req.headers);
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("x-nonce");
  headers.delete(PUBLIC_PAGE_HEADER);
  return headers;
}

/** 這個請求的 KV 版本戳副本;沒綁 CMS_KV、拿不到 context → undefined(一切照舊走 D1)。 */
function stampsKv(): KvTarget | undefined {
  try {
    const { env, ctx } = getCloudflareContext();
    return kvTargetFrom(env, ctx);
  } catch {
    return undefined;
  }
}

/**
 * 站台可以用 Worker 的環境變數 CMS_CSP=report-only 暫時退回「只回報、不攔截」——
 * 例如 Cloudflare 在區域層級自動插入的 script(Rocket Loader、Web Analytics 自動
 * 安裝)被擋、又沒辦法馬上改設定時。改環境變數不必重新建置。
 */
function enforcing(): boolean {
  try {
    const env = getCloudflareContext().env as unknown as { CMS_CSP?: unknown };
    return env.CMS_CSP !== "report-only";
  } catch {
    return true;
  }
}

async function publicPage(req: NextRequest) {
  const headers = cleanRequestHeaders(req);
  // 只有 GET / HEAD 用 KV 的戳:POST 到公開頁的是 server action(表單送出等會寫東西的
  // 請求),照舊讀 D1。client 端換頁與 prefetch 也是 GET,一樣蓋上 —— 它們一樣要渲染頁面。
  const kv = req.method === "GET" || req.method === "HEAD" ? stampsKv() : undefined;
  if (kv) headers.set(PUBLIC_PAGE_HEADER, PUBLIC_PAGE_VALUE);
  // client 端換頁(RSC payload)與 prefetch 不是文件:沒有要執行的 inline script,
  // CSP 標頭也不會被套用 —— 不必產生 nonce,更不必查 D1。
  if (req.headers.get("rsc") === "1" || req.headers.has("next-router-prefetch")) {
    return NextResponse.next({ request: { headers } });
  }

  let hosts: readonly string[] = [];
  try {
    hosts = await cachedApprovedScriptHosts(getCloudflareContext().env.DB, kv);
  } catch (e) {
    // 讀不到白名單:照樣 enforce,只是不放行任何外部主機(核准過的外部 script 這一頁
    // 載不到,違規會回報到 /api/csp-report)。寧可少一個行銷浮層,不要整站不設防。
    console.error("[csp] could not read approved script hosts", e);
  }

  let input: PublicPolicyInput;
  let enforced: string;
  let reportOnly: string;
  try {
    input = {
      nonce: createNonce(),
      hosts,
      dev: process.env.NODE_ENV !== "production",
      errorDsn: process.env.NEXT_PUBLIC_CMS_ERROR_DSN,
    };
    enforced = enforcedPublicPolicy(input);
    reportOnly = reportOnlyPolicy(input);
  } catch (e) {
    // 組不出 policy(理論上不會):頁面照常,只是這一次沒有 CSP。middleware 丟例外
    // 會讓每一個公開頁都 500。
    console.error("[csp] could not build the public policy", e);
    return NextResponse.next({ request: { headers } });
  }

  const enforce = enforcing();
  headers.set("x-nonce", input.nonce);
  // Next 讀這個請求標頭拿 nonce(兩種標頭名都認),蓋到它自己的 inline script 上。
  headers.set(enforce ? "content-security-policy" : "content-security-policy-report-only", enforced);
  const res = NextResponse.next({ request: { headers } });
  if (enforce) res.headers.set("Content-Security-Policy", enforced);
  res.headers.set("Content-Security-Policy-Report-Only", reportOnly);
  return res;
}
