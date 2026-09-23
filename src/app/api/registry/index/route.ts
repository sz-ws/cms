import { requireAuth, authErrorResponse } from "@/lib/auth";
import { fetchRegistryIndex, type RegistryIndexEntry } from "@/lib/registry-client";
import { satisfies } from "@/ext/semver";
import { CORE_API_VERSION } from "@/ext/version";
import { availableServices } from "@/ext/service-requirements";
import { isBuiltinDeclarative } from "@/ext/builtin-declaratives";
import { getExtRuntime } from "@/ext/loader";
import { byId, listInstalledPlugins, type InstalledPluginInfo } from "@/ext/installed-plugins";
import { listingVerdict } from "@/ext/plugin-ref";
import { scriptsCompiledIn } from "@/ext/dx/scripts-compiled";

// core-v2 §3.4:GET /api/registry/index。admin only。
// 對每個 configured source 抓 registry.json,merge entries,並附上
// installed?/installedVersion/compatible 供 Browse tab 使用。
//
// 1.50.0:「已安裝」改成「裝的就是這一個」。同 id 裝的是別的插件時 installed 為
// false、conflict 說明是哪一種:
//   identity —— 兩邊都有 identity 而且不同,不能互相更新
//   source   —— 已安裝的是從別的來源裝的(1.52.0 起 identity 相同也算:安裝狀態、更新、
//               付費插件的 access 都以 (來源, id) 為準);管理員確認後才能改用這個來源
//               (install route 再拿實際的 manifest 比一次 identity)
// 規則見 @/ext/plugin-ref 的 listingVerdict。
//   kind     —— 同 id 是另一種插件(程式碼 vs 宣告式)
// installedPlugins 給商店畫面判斷相依(需要的插件裝了沒、啟用了沒)與「誰用了它」。
// 1.51.0:scriptsCompiled —— 這個站把宣告式插件的前台編進了網站,安裝不會要求核准
// script,商店詳情改顯示一句說明(見 @/ext/dx/scripts-compiled)。只在 true 時帶。
// 1.52.0:付費插件的 access / offer 由 registry-client 解析,原樣帶給商店;errors 帶上
// registry 回的 http 狀態碼(401 / 403 = 金鑰不能用),商店據此換成白話。
export async function GET(): Promise<Response> {
  try {
    await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  const [{ entries, errors }, installed] = await Promise.all([
    fetchRegistryIndex(),
    getExtRuntime().then((rt) => listInstalledPlugins(rt.all)),
  ]);
  const installedById = byId(installed);

  // 1.49.0:底座自帶的 id(商品目錄)就算某個來源還列著,也不在商店出現。
  const items = entries.filter((entry) => !isBuiltinDeclarative(entry.id)).map((entry) => {
    const plugin = installedById.get(entry.id);
    const match = matchInstalled(entry, plugin);
    // 程式碼插件的 registry.json 還沒寫相依時,已經編譯進來的那一份自己知道
    // (Extension.requiresExtensions)。
    const requiresExtensions =
      entry.requiresExtensions ??
      (entry.kind === "code" && match.installed && plugin && plugin.requires.length > 0 ? plugin.requires : undefined);
    return {
      ...entry,
      requiresExtensions,
      installed: match.installed,
      installedVersion: match.installed ? match.version : null,
      conflict: match.conflict,
      installedSource: match.conflict === "source" ? match.source : null,
      compatible: satisfies(CORE_API_VERSION, entry.coreApi),
      ...(entry.kind === "declarative" && scriptsCompiledIn(entry.id) ? { scriptsCompiled: true } : {}),
    };
  });

  // manifest.requires 的滿足判定基準:目前有 provider 的 capability 全集
  // (RegistryBrowser 對照 entry.requires 算 met/unmet)。
  const services = await availableServices();

  // installedCode:編譯進這次部署的程式碼插件(version 取自 Extension 本身,不是 DB 列
  // —— 讓商店能比對「已安裝但可更新」);enabled 看 extensions 表。
  const installedCode = installed
    .filter((p) => p.kind === "code")
    .map((p) => ({ id: p.id, version: p.version, enabled: p.enabled }));

  // name 與相依的 reason 可能是多語物件,由商店畫面依使用者語系解析。
  const installedPlugins = installed.map((p) => ({
    id: p.id,
    kind: p.kind,
    enabled: p.enabled,
    identity: p.identity ?? null,
    name: p.name,
  }));

  return Response.json({ entries: items, errors, services, installedCode, installedPlugins });
}

type Match =
  | { installed: true; version: string; conflict: null; source: null }
  | { installed: false; version: null; conflict: null | "identity" | "kind"; source: null }
  | { installed: false; version: null; conflict: "source"; source: string };

function matchInstalled(entry: RegistryIndexEntry, plugin: InstalledPluginInfo | undefined): Match {
  if (!plugin) return { installed: false, version: null, conflict: null, source: null };
  if (plugin.kind !== entry.kind) return { installed: false, version: null, conflict: "kind", source: null };
  // 程式碼插件的 source 恆為 null,所以同一條規則下只會比 identity(兩邊都有時)。
  const verdict = listingVerdict(plugin, { identity: entry.identity ?? null, source: entry.source });
  if (verdict.ok) return { installed: true, version: plugin.version, conflict: null, source: null };
  if (verdict.error === "source_changed") {
    return { installed: false, version: null, conflict: "source", source: verdict.installedSource };
  }
  return { installed: false, version: null, conflict: "identity", source: null };
}
