import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { SetupForm } from "./SetupForm";

export const dynamic = "force-dynamic";

// 04 §6:/setup 若 users 非空 → redirect("/login")。
// 在 (admin) layout 之外,I18nProvider 自己包(同 login/page.tsx 的模式)。
export default async function SetupPage() {
  const rows = await db().select({ id: users.id }).from(users).limit(1);
  if (rows.length > 0) redirect("/login");

  const locale = await getLocale();
  const messages = getMessages(locale);

  return (
    <I18nProvider locale={locale} messages={messages}>
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm">
          <h1 className="mb-6 text-center text-2xl font-semibold text-foreground">
            {messages["setup.title"]}
          </h1>
          <SetupForm />
        </div>
      </div>
    </I18nProvider>
  );
}
