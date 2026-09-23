import { requireAuth } from "@/lib/auth";
import { getAccessSections } from "@/lib/admin-nav";
import { listStaffRoles, presetMemberCounts } from "@/lib/staff-roles";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { RolesWorkspace } from "./RolesWorkspace";

export const dynamic = "force-dynamic";

// 1.50.0:角色與權限。左邊是角色(三個預設 + 站台自己建的),右邊是那個角色對每一個
// 後台頁的權限 —— 列直接取自側欄(lib/admin-nav.ts),所以新裝插件的頁自動出現。
// 只有管理者(自訂角色在這裡沒有門,requireAuth("admin") 對它永遠不過)。
export default async function RolesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAuth("admin");
  const [sections, roles, presetCounts, locale, params] = await Promise.all([
    getAccessSections(),
    listStaffRoles(),
    presetMemberCounts(),
    getLocale(),
    searchParams,
  ]);
  const m = getMessages(locale);
  const initial = typeof params.role === "string" ? params.role : undefined;

  return (
    <div className="flex flex-col gap-6 pb-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink/90">
          {m["roles.title"]}
        </h1>
        <p className="text-[13px] leading-relaxed text-ink/40">{m["roles.subtitle"]}</p>
      </div>
      <RolesWorkspace
        sections={sections}
        roles={roles}
        presetCounts={presetCounts}
        initialRole={initial}
      />
    </div>
  );
}
