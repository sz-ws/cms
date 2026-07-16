import { redirect } from "next/navigation";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { getSessionUser } from "@/lib/auth";
import { getSetting } from "@/lib/settings";
import { maybeRunJobs } from "@/lib/jobs";
import { getExtRuntime } from "@/ext/loader";
import { AdminShell, type AdminMenuItem } from "@/components/admin/AdminShell";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import { I18nProvider } from "@/lib/i18n/I18nProvider";

export const dynamic = "force-dynamic";

// 05 §1:admin/layout.tsx(Server Component)。
export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  // spec-login-providers.md §3:最小 guest gate。guest 只允許 /admin/account,
  // 其餘 admin 路徑一律 redirect 過去(視覺/sidebar 結構不動,由主線 UI 處理)。
  // pathname 由 middleware 注入的 x-pathname header 取得(layout Server Component
  // 無法直接拿 pathname)。
  if (user.role === "guest") {
    const pathname = (await headers()).get("x-pathname") ?? "";
    if (!pathname.startsWith("/admin/account")) {
      redirect("/admin/account");
    }
  }

  // Lazy fallback:節流的 core-jobs sweep(無 cron 環境的保底,見 src/lib/jobs.ts）。
  // maybeRunJobs 全程 best-effort、永不 throw,節流時僅一次便宜的 settings 讀,
  // 故不會拖慢 / 破壞 layout render。
  await maybeRunJobs();

  const siteTitle = await getSetting<string>("core.siteTitle", "My Site");
  const brandLogo = await getSetting<string>("core.brandLogo", "");
  const rt = await getExtRuntime();
  const locale = await getLocale();
  const messages = getMessages(locale);

  // 固定項 + 每個 enabled extension 的 adminPages(showInMenu !== false)。
  const extItems: AdminMenuItem[] = rt.enabled.flatMap((ext) =>
    (ext.adminPages ?? [])
      .filter((p) => p.showInMenu !== false)
      .map((p) => ({
        href: `/admin/ext/${ext.id}${p.slug ? `/${p.slug}` : ""}`,
        title: resolveLocalizedString(p.title, locale) ?? p.slug,
        icon: ext.icon,
      })),
  );

  let menu: AdminMenuItem[] = [
    { href: "/admin", title: messages["nav.dashboard"] },
    { href: "/admin/media", title: messages["nav.media"] },
    ...extItems,
    { href: "/admin/extensions", title: messages["nav.extensions"] },
    { href: "/admin/account", title: messages["nav.account"] },
    { href: "/admin/settings", title: messages["nav.settings"] },
    // Users(admin only)
    ...(user.role === "admin"
      ? [{ href: "/admin/users", title: messages["nav.users"] }]
      : []),
  ];

  // menu 過 filter:adminMenu(extension 可增刪排序 menu 項)。
  menu = await rt.hooks.applyFilters<AdminMenuItem[]>("filter:adminMenu", menu);

  // guest 只看得到帳戶入口(路徑 gate 在上方 redirect;這裡是視覺對齊 —— 不給一排
  // 點了只會被彈回來的導覽項)。放在 applyFilters 之後,extension 也塞不回來。
  if (user.role === "guest") {
    menu = menu.filter((item) => item.href === "/admin/account");
  }

  const navLabels = {
    workspace: messages["nav.group.workspace"],
    content: messages["nav.group.content"],
    shop: messages["nav.group.shop"],
    browse: messages["nav.browse"],
    installed: messages["nav.installed"],
    system: messages["nav.group.system"],
  };

  return (
    <I18nProvider locale={locale} messages={messages}>
      <AdminShell
        user={user}
        menu={menu}
        siteTitle={siteTitle}
        brandLogo={brandLogo}
        navLabels={navLabels}
      >
        {children}
      </AdminShell>
    </I18nProvider>
  );
}
