import {
  listingVerdict,
  unmetRequirements,
  type InstalledPlugin,
  type UnmetRequirement,
} from "@/ext/plugin-ref";
import type { LocalizedString } from "@/lib/i18n/localized";
import type { RegistryAccess, RegistryOffer } from "@/lib/registry-offer";

// 商店(RegistryBrowser)與相依畫面(PluginRequirements)共用的資料形狀,
// 對應 GET /api/registry/index 的回應。

/** 需要的插件(reason 可能是多語物件,畫面依語系解析)。 */
export interface RequiredPlugin {
  id: string;
  identity?: string;
  optional?: boolean;
  reason?: LocalizedString;
}

export interface RegistryEntry {
  id: string;
  /** 1.50.0:跨來源的全域名字。 */
  identity?: string;
  kind: "declarative" | "code";
  name: string;
  version: string;
  coreApi: string;
  description?: string;
  author?: string;
  source: string;
  installed: boolean;
  installedVersion: string | null;
  /**
   * 1.50.0:同 id 已經裝了別的插件。identity / kind = 不能互相更新,要先移除;
   * source = 從別的來源裝的(1.52.0 起 identity 相同也算),管理員確認後可以改用這個來源。
   */
  conflict?: "identity" | "source" | "kind" | null;
  /** conflict 為 source 時:目前那一個當初的來源。 */
  installedSource?: string | null;
  compatible: boolean;
  icon?: string;
  iconUrl?: string;
  banner?: string;
  screenshots?: string[];
  license?: string;
  tags?: string[];
  category?: string;
  deployment?: "instant" | "progressive" | "code-only";
  homepage?: string;
  repository?: string;
  supportUrl?: string;
  supportEmail?: string;
  capabilities?: string[];
  /** manifest.requires passthrough:服務需求(對照 IndexResponse.services 判定)。 */
  requires?: { capability: string; optional?: boolean; reason?: string }[];
  /** 1.50.0:需要的其他插件。 */
  requiresExtensions?: RequiredPlugin[];
  /** 1.51.0:這個站把它的前台編進了網站 —— 安裝不用核准 script。 */
  scriptsCompiled?: boolean;
  /** 1.52.0 付費插件:這把金鑰對它的開通狀態(閘道產生)。沒有 = 免費。 */
  access?: RegistryAccess;
  /** 價格與說明;只有同時有 access 時才會出現(伺服器已驗證、消毒)。 */
  offer?: RegistryOffer;
}

/** 站上已安裝的插件(name 可能是多語物件,畫面依語系解析)。 */
export interface InstalledPluginRef extends InstalledPlugin {
  name: LocalizedString;
}

export interface SourceFetchError {
  source: string;
  error: string;
  /** registry 回的 http 狀態碼;401 / 403 = 這個來源的金鑰不能用。 */
  status?: number;
}

export interface IndexResponse {
  entries: RegistryEntry[];
  errors: SourceFetchError[];
  /** 目前有 provider 的 capability 全集(requires 的滿足判定基準)。 */
  services?: string[];
  /** 編譯進 bundle 的 code extension(id/version = bundle 事實,enabled = DB 列)。 */
  installedCode?: { id: string; version: string; enabled: boolean }[];
  /** 1.50.0:站上所有已安裝的插件(判斷相依用)。 */
  installedPlugins?: InstalledPluginRef[];
}

/** 來源的顯示名稱:去掉 https:// 與結尾的斜線(路徑保留,同一台主機上的兩個來源分得開)。 */
export function sourceLabel(source: string): string {
  return source.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/** 來源的主機名(「提供者」、「已從 <主機> 安裝」)。 */
export function sourceHost(source: string): string {
  try {
    return new URL(source).host;
  } catch {
    return sourceLabel(source);
  }
}

/** 這個插件的必要插件裡,還沒裝好、啟用的(空陣列 = 可以裝)。 */
export function entryUnmetPlugins(
  entry: RegistryEntry,
  installed: ReadonlyMap<string, InstalledPluginRef>,
): UnmetRequirement[] {
  return unmetRequirements(entry.requiresExtensions, installed);
}

/**
 * 剛裝好一個插件之後,就地更新商店資料:它自己變成已安裝;其他來源的同 id 項目
 * 依 index route 同一套規則(listingVerdict)變成衝突;已安裝清單補上它,依賴它的插件立刻看得到。
 */
export function markInstalled(
  data: IndexResponse,
  id: string,
  source: string,
): IndexResponse {
  const installedEntry = data.entries.find((e) => e.id === id && e.source === source);
  if (!installedEntry) return data;
  const entries = data.entries.map((e): RegistryEntry => {
    if (e.id !== id) return e;
    if (e === installedEntry) {
      return { ...e, installed: true, installedVersion: e.version, conflict: null, installedSource: null };
    }
    const verdict = listingVerdict(
      { identity: installedEntry.identity ?? null, source },
      { identity: e.identity ?? null, source: e.source },
    );
    return verdict.ok
      ? { ...e, installed: true, installedVersion: installedEntry.version, conflict: null, installedSource: null }
      : {
          ...e,
          installed: false,
          installedVersion: null,
          conflict: verdict.error === "source_changed" ? "source" : "identity",
          installedSource: verdict.error === "source_changed" ? verdict.installedSource : null,
        };
  });
  const installedPlugins = [
    ...(data.installedPlugins ?? []).filter((p) => p.id !== id),
    {
      id,
      kind: installedEntry.kind,
      enabled: true,
      identity: installedEntry.identity ?? null,
      name: installedEntry.name,
    },
  ];
  return { ...data, entries, installedPlugins };
}
