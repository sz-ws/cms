import { notFound, redirect } from "next/navigation";
import { getSessionAccess, requireAuth } from "@/lib/auth";
import { guardExtAdminPage } from "@/lib/access-guards";
import { getExtRuntime } from "@/ext/loader";
import { adminPageHref, replacedAdminPages } from "@/ext/admin-menu";

export const dynamic = "force-dynamic";

// 03 §6a:Extension Admin 頁 dispatch。session auth 由上層 admin/layout.tsx 保證(見 04);
// Phase E §5: role gate (admin-only, mirrors admin/media/page.tsx) is checked
// HERE explicitly, since extension admin pages can expose settings/data
// management surfaces equivalent to core admin pages.
// 1.50.0:自訂角色看這一頁(或它 accessAs 的那一頁)的授權;沒有就 404。預設角色照舊
// 只有管理者(lib/access-guards.ts)。
export default async function ExtAdminPage({
  params,
  searchParams,
}: {
  params: Promise<{ extId: string; page?: string[] }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const { extId, page } = await params;
  const rt = await getExtRuntime();
  const ext = rt.byId(extId);
  const slug = (page ?? []).join("/");
  const adminPage = ext?.adminPages?.find((p) => p.slug === slug);
  // 1.46.0:這一頁被別的已啟用 extension 取代(AdminPage.replaces)→ 轉過去,網址參數照帶。
  // 預設角色照舊先過 requireAuth("admin");自訂角色直接轉,取代它的那一頁自己守門。
  const replacement = replacedAdminPages(rt.enabled).get(adminPageHref(extId, slug));
  if (replacement) {
    if (!(await getSessionAccess())?.access) await requireAuth("admin");
    const query = new URLSearchParams(await searchParams).toString();
    redirect(query ? `${replacement}?${query}` : replacement);
  }
  await guardExtAdminPage(extId, adminPage ?? { slug });
  if (!adminPage) notFound();
  const C = adminPage.component;
  return <C params={{ extId }} searchParams={await searchParams} />;
}
