import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { declarativeExtensions } from "@/lib/schema";
import { satisfies } from "../semver";
import { CORE_API_VERSION } from "../version";

// [core] 2.0:直接讀 declarative_extensions 的地方(Content API、登入 provider、sitemap、型別清單、AI 工具、
// 關聯連結)跟 loader 用同一條規則決定「這個插件現在算不算載入」:enabled = 1,而且 manifest 的 coreApi
// 範圍包含這個 core(CORE_API_VERSION)。loader 排除的插件(例如還是 "^1.x" 的),它的內容、登入方式、
// 網址不能從旁邊的路再露出來。

/** manifest 的 coreApi 範圍包含這個 core。interpret(loader)與這裡共用。 */
export function coreApiCompatible(coreApi: unknown): boolean {
  return typeof coreApi === "string" && coreApi.trim().length > 0 && satisfies(CORE_API_VERSION, coreApi);
}

/** 存起來的 manifest(JSON 字串)與這個 core 相容;讀不懂 = 不相容。 */
export function storedManifestCompatible(manifest: string): boolean {
  try {
    return coreApiCompatible((JSON.parse(manifest) as { coreApi?: unknown } | null)?.coreApi);
  } catch {
    return false;
  }
}

export interface EnabledManifestRow {
  id: string;
  /** 存起來的 manifest JSON 字串(呼叫端照舊自己 parse / 驗證)。 */
  manifest: string;
}

/** 啟用中、而且與這個 core 相容的宣告式插件;給 id 就只查那一個。 */
export async function enabledCompatibleManifests(id?: string): Promise<EnabledManifestRow[]> {
  const enabled = eq(declarativeExtensions.enabled, 1);
  const rows = await db()
    .select({ id: declarativeExtensions.id, manifest: declarativeExtensions.manifest })
    .from(declarativeExtensions)
    .where(id === undefined ? enabled : and(eq(declarativeExtensions.id, id), enabled));
  return rows.filter((row) => storedManifestCompatible(row.manifest));
}
