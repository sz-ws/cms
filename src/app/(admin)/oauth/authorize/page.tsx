import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, getSessionAccess } from "@/lib/auth";
import { hitRateLimit } from "@/lib/rate-limit";
import { getPlainSetting } from "@/lib/settings";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { format } from "@/lib/i18n/index";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { isMcpEnabled } from "@/lib/mcp/site";
import { pageMcpOrigin } from "@/lib/mcp/page-origin";
import { getClient } from "@/lib/mcp/clients";
import { connectPolicy } from "@/lib/mcp/grants";
import {
  appRedirectUrl,
  checkAuthorizeRequest,
  issueConsentTicket,
  redirectDisplayHost,
} from "@/lib/mcp/consent";
import { ConsentForm } from "./ConsentForm";

export const dynamic = "force-dynamic";

// AI 連線的同意畫面(OAuth 2.1 authorization endpoint)。AI App 把管理員的瀏覽器送到這裡:
//
//   1. 開關關著 / 不認得的 App / 回呼網址對不上 → 在這一頁說明,不導回(見 lib/mcp/consent.ts)。
//   2. 其餘參數不對 → 帶 error 導回 App。
//   3. 沒登入 → 走網站平常的登入(/login?next=…),登入後回到這裡(sign-in-continue 的規則)。
//   4. 登入了但不是管理員 → 說明只有管理員可以連線。
//   5. 同意畫面:哪個 App、連到哪個網站、用誰的帳號;選「只能查看 / 可以查看與修改」,
//      允許或拒絕。按鈕送出的是簽過的同意票(POST /api/oauth/authorize)。
//
// 放在 /admin 之外:middleware 對 /admin 沒 cookie 的轉址只帶路徑、會丟掉整串授權參數;
// 後台的側欄外框也不該包住這一頁。這個路徑算公開頁(lib/csp.ts 的 isPublicPagePath),
// 所以拿得到 enforce 的 CSP —— frame-ancestors 'none',加上 next.config 全站的
// X-Frame-Options: DENY,同意按鈕不可能被嵌進別人的頁面裡點(clickjacking)。

type SearchParams = Record<string, string | string[] | undefined>;

const RATE_LIMIT = { namespace: "mcp-authorize", limit: 30, windowMs: 60_000 };

/** 原本的查詢字串(登入後要原樣回到這一頁)。 */
function queryString(sp: SearchParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === "string") params.append(key, value);
    else if (Array.isArray(value)) for (const v of value) params.append(key, v);
  }
  return params.toString();
}

function requestTimestamp(): number {
  return Date.now();
}

function Frame({ siteTitle, children }: { siteTitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-[#fbfaf9] text-black antialiased selection:bg-black selection:text-white">
      <div className="p-6 text-[12px] font-medium text-black/55">{siteTitle}</div>
      <main className="flex flex-1 items-start justify-center px-4 pt-[8vh] pb-16">
        <div className="w-full max-w-[26rem]">{children}</div>
      </main>
    </div>
  );
}

function Notice({ siteTitle, title, body }: { siteTitle: string; title: string; body: string }) {
  return (
    <Frame siteTitle={siteTitle}>
      <h1 className="text-[20px] font-semibold tracking-[-0.015em] text-black/90">{title}</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-black/55">{body}</p>
    </Frame>
  );
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const locale = await getLocale();
  const m = getMessages(locale);
  const rawTitle = await getPlainSetting<unknown>("core.siteTitle", "");
  const siteTitle = typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim() : "";

  if (!(await isMcpEnabled())) {
    return <Notice siteTitle={siteTitle} title={m["consent.off.title"]} body={m["consent.off.body"]} />;
  }

  const ip = (await headers()).get("cf-connecting-ip") ?? "local";
  if (await hitRateLimit(ip, RATE_LIMIT)) {
    return <Notice siteTitle={siteTitle} title={m["consent.busy.title"]} body={m["consent.busy.body"]} />;
  }

  const origin = await pageMcpOrigin();
  const clientId = typeof sp.client_id === "string" ? sp.client_id : null;
  const client = await getClient(clientId);
  const check = checkAuthorizeRequest(sp, client, origin);
  if (!check.ok) {
    if (check.kind === "page") {
      return <Notice siteTitle={siteTitle} title={m["consent.unknown.title"]} body={m["consent.unknown.body"]} />;
    }
    redirect(
      appRedirectUrl(check.redirectUri, {
        error: check.error,
        error_description: check.description,
        state: check.state,
        iss: origin,
      }),
    );
  }

  const session = await getSessionAccess();
  if (!session) {
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${queryString(sp)}`)}`);
  }
  const policy = connectPolicy(session.user);
  if (!policy.connect) {
    return (
      <Notice
        siteTitle={siteTitle}
        title={m["consent.notAdmin.title"]}
        body={format(m["consent.notAdmin.body"], { email: session.user.email })}
      />
    );
  }

  const sessionSecret = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  const ticket = await issueConsentTicket(check.request, session.user.id, sessionSecret, requestTimestamp());
  const app = client?.name || m["aiConnect.unnamed"];

  return (
    <I18nProvider locale={locale} messages={m}>
      <Frame siteTitle={siteTitle}>
        <h1 className="text-[20px] font-semibold tracking-[-0.015em] text-balance text-black/90">
          {format(m["consent.title"], { app, site: siteTitle || new URL(origin).host })}
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-black/55">
          {format(m["consent.body"], { email: session.user.email })}
        </p>
        <ConsentForm
          ticket={ticket}
          canWrite={policy.write}
          returnHost={redirectDisplayHost(check.request.redirectUri)}
        />
      </Frame>
    </I18nProvider>
  );
}
