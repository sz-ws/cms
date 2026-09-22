import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  extensions as extTable,
  declarativeExtensions as dxTable,
} from "@/lib/schema";
import { getExtRuntime } from "@/ext/loader";
import { pendingCodeUpgrades } from "@/ext/manager";
import { parseManifest, type DeclarativeManifest } from "@/ext/dx/manifest";
import { hashScripts, parseScriptsApproval } from "@/ext/dx/scripts";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import {
  ExtensionsManager,
  type ExtensionRow,
} from "./ExtensionsManager";
import { isBaseManaged } from "@/ext/builtin-declaratives";

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
  // 1.45.0:部署了新版、還沒套用的(migration 沒跑或版號沒更新)。
  const upgrades = await pendingCodeUpgrades(dbRows);

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
    upgrade: upgrades.get(e.id) ?? null,
  }));

  // declarative extensions:name/description 取自 manifest(驗證後)。
  // 1.49.0:底座管的(商品目錄)不列 —— 它沒有版本、不能在這裡啟停,開關在商店設定。
  const dxDbRows = await db().select().from(dxTable);
  const dxRows: ExtensionRow[] = await Promise.all(
    dxDbRows.filter((r) => !isBaseManaged(r.id, r.source)).map(async (r) => {
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
        scripts: await scriptsState(dm, r.scriptsApproval),
      };
    }),
  );

  const rows = [...codeRows, ...dxRows];

  return (
    <div className="flex flex-col gap-6">
      {/* 頁首語彙對齊 users/media/settings:22px h1 + 13px 副標(捨舊 PageTitle)。 */}
      <div className="flex flex-col gap-1.5">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink/90">
          {m["extensions.title"]}
        </h1>
        <p className="text-[13px] leading-relaxed text-ink/40">
          {m["extensions.subtitle"]}
        </p>
      </div>
      <ExtensionsManager extensions={rows} />
    </div>
  );
}

/** 1.48.0:核准紀錄與目前內容對得上才算執行中(與 scripts-widget 同一個判斷)。 */
async function scriptsState(
  manifest: DeclarativeManifest | undefined,
  rawApproval: string | null,
): Promise<ExtensionRow["scripts"]> {
  if (!manifest?.scripts) return null;
  const approval = parseScriptsApproval(rawApproval);
  if (!approval) return "stopped";
  return approval.hash === (await hashScripts(manifest.scripts)) ? "running" : "stopped";
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
