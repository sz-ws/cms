import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  extensions as extTable,
  declarativeExtensions as dxTable,
} from "@/lib/schema";
import { getExtRuntime } from "@/ext/loader";
import { parseManifest } from "@/ext/dx/manifest";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import {
  ExtensionsManager,
  type ExtensionRow,
} from "./ExtensionsManager";

export const dynamic = "force-dynamic";

// 05 §2 / core-v2 §3.3:列出 code registry(rt.all)+ declarative_extensions 列。
// 每列 name/version/description/狀態 Badge + Enable/Disable(declarative 標「Declarative」badge)。
// Phase E §5: requireAuth("admin") mirrors admin/media/page.tsx — installing/
// enabling/disabling extensions is admin-only, not just any authenticated
// (editor) session.
export default async function ExtensionsPage() {
  await requireAuth("admin");

  const locale = await getLocale();
  const m = getMessages(locale);
  const rt = await getExtRuntime();

  // DB 中的 code extensions 列:判定 enabled(=1)與 installed(存在列)。
  const dbRows = await db().select().from(extTable);
  const enabledIds = new Set(
    dbRows.filter((r) => r.enabled === 1).map((r) => r.id),
  );
  const installedIds = new Set(dbRows.map((r) => r.id));

  // §1 #1/#2:name/description 可為 LocalizedString;此 server 頁以 getLocale() resolve
  // 成純字串後才進 ExtensionsManager(client DTO,ExtensionRow.name/description 為 string)。
  const codeRows: ExtensionRow[] = rt.all.map((e) => ({
    id: e.id,
    name: resolveLocalizedString(e.name, locale) ?? e.id,
    version: e.version,
    description: resolveLocalizedString(e.description, locale),
    enabled: enabledIds.has(e.id),
    installed: installedIds.has(e.id),
    kind: "code",
    issue: enabledIds.has(e.id) ? (rt.unavailableById.get(e.id) ?? null) : null,
  }));

  // declarative extensions:name/description 取自 manifest(驗證後)。
  const dxDbRows = await db().select().from(dxTable);
  const dxRows: ExtensionRow[] = dxDbRows.map((r) => {
    const parsed = parseManifest(safeJson(r.manifest));
    const dm = parsed.manifest;
    return {
      id: r.id,
      name: resolveLocalizedString(dm?.name, locale) ?? r.id,
      version: r.version,
      description: resolveLocalizedString(dm?.description, locale),
      enabled: r.enabled === 1,
      installed: true,
      kind: "declarative" as const,
      issue: r.enabled === 1 ? (rt.unavailableById.get(r.id) ?? null) : null,
    };
  });

  const rows = [...codeRows, ...dxRows];

  return (
    <div className="flex flex-col gap-6">
      {/* 頁首語彙對齊 users/media/settings:22px h1 + 13px 副標(捨舊 PageTitle)。 */}
      <div className="flex flex-col gap-1.5">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-black/90">
          {m["extensions.title"]}
        </h1>
        <p className="text-[13px] leading-relaxed text-black/40">
          {m["extensions.subtitle"]}
        </p>
      </div>
      <ExtensionsManager extensions={rows} />
    </div>
  );
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
