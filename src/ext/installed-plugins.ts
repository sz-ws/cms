import { db } from "@/lib/db";
import {
  declarativeExtensions as dxTable,
  extensions as extTable,
} from "@/lib/schema";
import type { LocalizedString } from "@/lib/i18n/localized";
import { parseManifest } from "./dx/manifest";
import type { Extension } from "./types";
import {
  codeRequirements,
  type InstalledPlugin,
  type PluginRequirement,
} from "./plugin-ref";

// 1.50.0:站上裝了哪些插件,以及它們各自需要誰。商店索引(誰已安裝、誰用了誰)、
// install route(相依擋關)、已安裝列表(缺了什麼)三處共用同一份判斷。
//
// 程式碼插件以「這次部署編譯進來的」為準(呼叫端傳 extensions/registry.ts 的陣列,
// 通常是 getExtRuntime().all —— 這裡不直接 import 它,免得每個用到的 route 都把整包
// 插件拉進來),啟用與否看 extensions 表;宣告式插件看 declarative_extensions 列,
// identity 與相依取自存下來的 manifest —— 安裝時驗證過、存進去的就是當時裝的那一份,
// 所以不另開欄位存 identity(兩份會漂移)。

export interface InstalledPluginInfo extends InstalledPlugin {
  name: LocalizedString;
  /** 程式碼插件:這次部署編譯進來的版本;宣告式:存下來的版本。 */
  version: string;
  /** 宣告式插件當初從哪個來源裝的(開發模式 inline 安裝為 null);程式碼插件恆為 null。 */
  source: string | null;
  requires: PluginRequirement[];
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function listInstalledPlugins(
  codeRegistry: readonly Extension[],
): Promise<InstalledPluginInfo[]> {
  const [codeRows, dxRows] = await Promise.all([
    db().select({ id: extTable.id, enabled: extTable.enabled }).from(extTable),
    db()
      .select({
        id: dxTable.id,
        enabled: dxTable.enabled,
        version: dxTable.version,
        manifest: dxTable.manifest,
        source: dxTable.source,
      })
      .from(dxTable),
  ]);
  const enabledCode = new Set(codeRows.filter((r) => r.enabled === 1).map((r) => r.id));

  const code: InstalledPluginInfo[] = codeRegistry.map((ext) => ({
    id: ext.id,
    kind: "code",
    enabled: enabledCode.has(ext.id),
    identity: ext.identity ?? null,
    name: ext.name,
    version: ext.version,
    source: null,
    requires: codeRequirements(ext.requiresExtensions),
  }));

  const declarative: InstalledPluginInfo[] = dxRows.map((row) => {
    const manifest = parseManifest(safeJson(row.manifest)).manifest;
    return {
      id: row.id,
      kind: "declarative",
      enabled: row.enabled === 1,
      identity: manifest?.identity ?? null,
      name: manifest?.name ?? row.id,
      version: row.version,
      source: row.source,
      requires: manifest?.requiresExtensions ?? [],
    };
  });

  return [...code, ...declarative];
}

export function byId<T extends { id: string }>(plugins: readonly T[]): Map<string, T> {
  return new Map(plugins.map((plugin) => [plugin.id, plugin]));
}
