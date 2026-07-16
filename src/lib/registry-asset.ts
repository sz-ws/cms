// core-v2 marketplace media proxy — pure, unit-testable guards for
// GET /api/registry/asset. Kept separate from registry-client.ts (which owns
// the actual network fetch) so the allow-list regex + extension→content-type
// map can be exercised directly in tests without pulling in D1/fetch/settings
// machinery.

// Extension id 規則：與 manifest.ts / registry-client.ts 的 ID_RE 保持一致，
// 避免 id 被用於 path traversal（如 "../../secret"）或注入額外路徑段。
// registry-client.ts 的 ID_RE 直接 re-export 這個，單一事實來源。
export const EXTENSION_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

// Marketplace asset 檔名白名單：單一路徑段（不含 "/"），只允許已知圖片副檔名。
// 比 registry-client 既有的 ASSET_FILENAME_RE 更嚴格（那個還放行 style.css）——
// 這支 proxy 只服務 <img> 標籤要用的圖片（icon/banner/screenshots）。
const ASSET_FILE_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/i;

const CONTENT_TYPE_BY_EXT: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};

/**
 * 安全的 Content-Type，只從檔名的副檔名推導——絕不信任 upstream response 的
 * Content-Type header（第三方 registry 可能謊報）。不在白名單內回傳 null。
 */
export function assetContentType(file: string): string | null {
  const dot = file.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = file.slice(dot + 1).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] ?? null;
}

/**
 * true 若 `file` 是單一路徑段、不含 ".."、且副檔名在圖片白名單內。
 * 呼叫端（GET /api/registry/asset）必須先過這關才可拿 file 去組 fetch URL。
 */
export function isValidAssetFile(file: string): boolean {
  if (file.includes("..")) return false;
  if (!ASSET_FILE_RE.test(file)) return false;
  return assetContentType(file) !== null;
}
