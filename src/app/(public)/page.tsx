import type { ComponentType } from "react";
import { getExtRuntime } from "@/ext/loader";
import { getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

// 03 §6:首頁用 filter:publicHome 取得要渲染的 component,
// 無則顯示內建的極簡歡迎頁(站名 + 描述,來自 settings)。
export default async function HomePage() {
  const rt = await getExtRuntime();
  const home = await rt.hooks.applyFilters<ComponentType | null>(
    "filter:publicHome",
    null,
  );

  if (home) {
    const C = home;
    return <C />;
  }

  const siteTitle = await getSetting<string>("core.siteTitle", "My Site");
  const siteDescription = await getSetting<string>("core.siteDescription", "");

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-3 px-6 py-16">
      <h1 className="text-3xl font-semibold text-gray-900">{siteTitle}</h1>
      {siteDescription && (
        <p className="text-base text-gray-600">{siteDescription}</p>
      )}
    </main>
  );
}
