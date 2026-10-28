import { isNewerVersion, satisfies } from "@/ext/semver";

// registry 保留的舊版本(registry.json 的 `versions`):只在相容性斷掉時才留,最新版不在裡面。
// 格式見 registry repo 的 README。純函式,商店畫面與 API 共用。

export interface RegistryVersionRef {
  version: string;
  coreApi: string;
}

export const REGISTRY_VERSION_RE = /^\d+\.\d+\.\d+$/;
const MAX_VERSIONS = 20;
const CORE_API_MAX = 40;

/** 解析 index 的 `versions`。格式不對的項目丟掉;全部不對或沒有就回 undefined。由新到舊排好。 */
export function parseVersionRefs(raw: unknown): RegistryVersionRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const refs: RegistryVersionRef[] = [];
  for (const item of raw.slice(0, MAX_VERSIONS)) {
    const v = (item as { version?: unknown })?.version;
    const range = (item as { coreApi?: unknown })?.coreApi;
    if (typeof v === "string" && REGISTRY_VERSION_RE.test(v) && typeof range === "string" && range.length > 0 && range.length <= CORE_API_MAX) {
      refs.push({ version: v, coreApi: range });
    }
  }
  refs.sort((a, b) => (isNewerVersion(a.version, b.version) ? -1 : isNewerVersion(b.version, a.version) ? 1 : 0));
  return refs.length > 0 ? refs : undefined;
}

/**
 * 這個站能裝哪一版:最新版相容就是最新版,否則是第一個相容的舊版本。都不相容回 null。
 * archived 為 true 表示挑到的是舊版本。
 */
export function pickInstallable(
  latest: RegistryVersionRef,
  archived: readonly RegistryVersionRef[] | undefined,
  coreVersion: string,
): (RegistryVersionRef & { archived: boolean }) | null {
  if (satisfies(coreVersion, latest.coreApi)) return { ...latest, archived: false };
  for (const ref of archived ?? []) {
    if (satisfies(coreVersion, ref.coreApi)) return { ...ref, archived: true };
  }
  return null;
}

/** registry 裡某個版本的路徑前綴:最新版是 `/extensions/<id>`,舊版本多一層 `/versions/<x.y.z>`。 */
export function extensionBasePath(id: string, version?: string): string {
  return version ? `/extensions/${id}/versions/${version}` : `/extensions/${id}`;
}
