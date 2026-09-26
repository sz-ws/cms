import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { getSetting } from "@/lib/settings";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { listLoginProviders } from "@/lib/oidc";
import { publicSignInPage } from "@/lib/sign-in-page";
import { LoginScreen } from "./LoginScreen";

export const dynamic = "force-dynamic";

// 04 §6:/login 先查 users 是否為空,空 → redirect("/setup")。
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const rows = await db().select({ id: users.id }).from(users).limit(1);
  if (rows.length === 0) redirect("/setup");

  const siteTitle = await getSetting<string>("core.siteTitle", "My Site");
  const locale = await getLocale();
  const messages = getMessages(locale);
  const sp = await searchParams;
  const nextParam = typeof sp.next === "string" ? sp.next : undefined;
  // OAuth callback 失敗以 /login?error=<code> 導回(spec-login-providers §5)。
  const oauthError = typeof sp.error === "string" ? sp.error : undefined;

  // 1.55.0:網站有統一的登入頁(插件宣告 signInPage)就轉過去,帶著 next 與錯誤碼。
  // ?form=1 留著這張後台表單:插件頁壞掉時,後台人員仍進得來。
  if (sp.form !== "1") {
    const page = await publicSignInPage();
    if (page) {
      const params = new URLSearchParams();
      if (nextParam) params.set("next", nextParam);
      if (oauthError) params.set("login_error", oauthError);
      const query = params.toString();
      redirect(query ? `${page}?${query}` : page);
    }
  }
  const providers = await listLoginProviders();

  return (
    <I18nProvider locale={locale} messages={messages}>
      <LoginScreen
        siteTitle={siteTitle}
        next={nextParam}
        providers={providers}
        oauthError={oauthError}
      />
    </I18nProvider>
  );
}
