import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { getSetting } from "@/lib/settings";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { listLoginProviders } from "@/lib/oidc";
import { publicSignInPage } from "@/lib/sign-in-page";
import { emailConfigured } from "@/lib/email";
import { LoginEntry } from "../LoginEntry";

// 2.0:/login 跟公開頁一樣算一次、整頁存起來,之後由 OpenNext 的快取攔截直接回應,冷的 Worker 也不必
// 先啟動 Next server 才畫得出表單;要等伺服器的只剩按下登入之後。路由設定與
// (public)/[[...slug]]/page.tsx 相同(說明見那裡):optional catch-all + generateStaticParams 回 []
// 讓 /login 在第一次造訪時才算(建置時沒有 D1),dynamic = "error" 讓讀 cookies()、headers()、
// searchParams 的程式直接報錯。
//
// 頁面裡只有網站層級的事:有沒有人(沒有 → /setup)、插件的登入頁、登入方式、寄不寄得出信、站名與語系。
// 這些都由會呼叫 publicContentChanged 的存檔改變:設定頁、首次設定、插件安裝 / 啟用 / 停用。
// 因人而異的事(網址的 next / error / form、是不是已經登入)在瀏覽器決定,見 ../login-entry.ts。
// 登入本身照舊由伺服器驗(/api/auth/*),頁面裡沒有任何秘密或個人資料。
export const dynamic = "error";
export const dynamicParams = true;
export const revalidate = false;
export function generateStaticParams(): { rest: string[] }[] {
  return [];
}

export default async function LoginPage({
  params,
}: {
  params: Promise<{ rest?: string[] }>;
}) {
  const { rest } = await params;
  if (rest && rest.length > 0) notFound();

  // 04 §6:還沒有任何使用者 → /setup(瀏覽器轉;首次設定完成時 publicContentChanged 讓這頁重算)。
  const rows = await db().select({ id: users.id }).from(users).limit(1);
  const needsSetup = rows.length === 0;

  const siteTitle = await getSetting<string>("core.siteTitle", "My Site");
  const locale = await getLocale();
  const messages = getMessages(locale);
  // 1.55.0:網站有統一的登入頁(插件宣告 signInPage)就轉過去;?form=1 留著這張後台表單。
  // 1.56.0:寄得出信才給「忘記密碼」。2.0:查不到(不是「沒設定」)就讓這次渲染失敗、不存(emailConfigured)。
  const [signInPage, providers, resetAvailable] = needsSetup
    ? [null, [], false]
    : await Promise.all([publicSignInPage(), listLoginProviders(), emailConfigured()]);

  return (
    <I18nProvider locale={locale} messages={messages}>
      <LoginEntry
        siteTitle={siteTitle}
        signInPage={signInPage}
        needsSetup={needsSetup}
        providers={providers}
        resetAvailable={resetAvailable}
      />
    </I18nProvider>
  );
}
