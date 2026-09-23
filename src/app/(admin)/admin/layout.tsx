import { redirect } from "next/navigation";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { getSessionAccess } from "@/lib/auth";
import { getSetting } from "@/lib/settings";
import { resolveAdminAppearance } from "@/lib/admin-theme";
import {
  normalizeStatusSets,
  resolveStatusSets,
  type ResolvedStatusSets,
} from "@/ext/record-status";
import { AdminTheme } from "@/components/admin/AdminTheme";
import { maybeRunJobs } from "@/lib/jobs";
import { getExtRuntime } from "@/ext/loader";
import { AdminShell } from "@/components/admin/AdminShell";
import type { AdminMenuItem } from "@/ext/admin-menu";
import {
  customRoleCanOpen,
  editorCanOpen,
  filterAdminMenu,
} from "@/ext/admin-access";
import {
  buildAdminMenu,
  buildAdminSections,
  shopNavLabels,
} from "@/lib/admin-nav";
import { isAgentAvailable } from "@/lib/ai";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
import type { PageSearchConfig } from "@/components/admin/PageSearch";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export const dynamic = "force-dynamic";

// 05 §1:admin/layout.tsx(Server Component)。
export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  // 1.50.0:layout 用「授權範圍外」的身分做判斷(自訂角色在這裡是 editor + access),
  // 不受頁面守門開的門影響 —— layout 與頁面同時 render,先後不定。
  const session = await getSessionAccess();
  if (!session) redirect("/login");
  const { user, access } = session;

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

  // Lazy fallback 不卡住 admin render:把保底 sweep 交給 waitUntil,在 response 之後完成。
  //
  // next dev 也走得到這條 —— initOpenNextCloudflareForDev() 會準備一份 context,
  // getCloudflareContext() 不會 throw,只是它的 waitUntil 是 no-op。所以 dev 下 sweep
  // 其實是一個沒人 await 的 floating promise;之所以無害,是因為 maybeRunJobs 內部
  // 整個包在 try/catch,任何失敗只會 console.error,不會變成 unhandled rejection。
  //
  // 底下的同步 await 只在真的完全拿不到 Cloudflare context 時才會踩到(非 Worker、
  // 非 dev 的執行環境),不是 next dev 的正常路徑。
  const jobs = maybeRunJobs();
  try {
    getCloudflareContext().ctx.waitUntil(jobs);
  } catch {
    await jobs;
  }

  const siteTitle = await getSetting<string>("core.siteTitle", "My Site");
  const brandLogo = await getSetting<string>("core.brandLogo", "");
  const appearance = resolveAdminAppearance(
    await getSetting("core.adminTheme", null),
    await getSetting("core.adminAccent", null),
  );
  const rt = await getExtRuntime();
  const locale = await getLocale();
  const messages = getMessages(locale);

  // 1.40.0:宣告了 search 的插件頁 → 頂欄搜尋框(components/admin/PageSearch.tsx)。
  const pageSearch: Record<string, PageSearchConfig> = {};
  // 不在 sidebar、但有自己標題的頁。少了這裡,麵包屑會退回把路徑段首字大寫(「Audit」、
  // 「Shipping」),與整個後台的本地化脫節。插件不在側欄的頁用它宣告的標題。
  const crumbTitles: Record<string, string> = { "/admin/agent/audit": messages["agent.audit.title"] };
  for (const ext of rt.enabled) {
    for (const page of ext.adminPages ?? []) {
      const href = `/admin/ext/${ext.id}${page.slug ? `/${page.slug}` : ""}`;
      if (page.showInMenu === false) {
        const title = resolveLocalizedString(page.title, locale);
        if (title) crumbTitles[href] = title;
      }
      if (!page.search) continue;
      pageSearch[href] = {
        placeholder: resolveLocalizedString(page.search.placeholder, locale) ?? "",
        dates: Boolean(page.search.fields.date),
      };
    }
  }

  // 1.40.0:狀態組(record-status.ts),過站台的 slot(filter:statusSets)再給後台畫。
  const baseStatusSets = resolveStatusSets(rt.enabled, (value) =>
    resolveLocalizedString(value, locale),
  );
  const statusSets = normalizeStatusSets(
    await rt.hooks.applyFilters<ResolvedStatusSets>("filter:statusSets", baseStatusSets),
    baseStatusSets,
  );

  // 1.39.0:AI 沒設定好時不給入口 —— 點進去只會看到每一句都回「尚未設定」的面板。
  const fullAdmin = user.role === "admin" && !access;
  let menu: AdminMenuItem[] = await buildAdminMenu({
    agent: fullAdmin && (await isAgentAvailable()),
    people: fullAdmin,
  });

  // 側欄只放打得開的頁(放在 filter:adminMenu 之後,extension 也塞不回來):
  // - guest:只有帳戶(路徑 gate 在上方 redirect;這裡是視覺對齊)。
  // - editor:儀表板與帳戶 —— 其餘頁是 requireAuth("admin"),點了只會被擋。
  // - 1.50.0 自訂角色:檢視以上的頁(規則在 ext/admin-access.ts)。
  if (user.role === "guest") {
    menu = menu.filter((item) => item.href === "/admin/account");
  } else if (access) {
    menu = filterAdminMenu(menu, customRoleCanOpen(access));
  } else if (user.role === "editor") {
    menu = filterAdminMenu(menu, editorCanOpen);
  }

  // 1.40.0:側欄分區也過 filter —— 站台可以改名、加區、排序、改收合方式,
  // 不必改 core 檔(規則與收斂在 ext/admin-menu.ts)。
  const [sections, shopLabels] = await Promise.all([
    buildAdminSections(),
    shopNavLabels(),
  ]);

  return (
    <I18nProvider locale={locale} messages={messages}>
      <AdminTheme initial={appearance}>
        <AdminShell
          user={user}
          menu={menu}
          siteTitle={siteTitle}
          brandLogo={brandLogo}
          sections={sections}
          pageSearch={pageSearch}
          statusSets={statusSets}
          shopLabels={shopLabels}
          crumbTitles={crumbTitles}
        >
          {children}
        </AdminShell>
      </AdminTheme>
    </I18nProvider>
  );
}
