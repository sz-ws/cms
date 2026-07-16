// roadmap #17:manifest capability feature-gating —— declarative extension 的
// 平台功能需求表。
//
// capability = "extension 需要的核心功能名"(manifest.capabilities[] 內的字串)。
// 這裡列出目前這個 core 版本「實際支援」的功能全集(CORE_FEATURES)。install 時
// 拿 manifest 宣告的 capabilities 逐一比對:
//   - 全部都在 CORE_FEATURES 內 → 放行。
//   - 有任何一個不在 → 代表這個 extension 需要「這個 core 不支援」的功能,多半是
//     manifest 是針對「更新版本的 core」寫的(那個版本才新增了對應功能)。此時
//     install 直接擋下 —— 這是刻意的 graceful degradation:與其讓 extension 裝上去
//     後才在 runtime 發現某功能不存在而莫名其妙壞掉,不如在 install 當下就把「這個
//     core 太舊,裝不了」講清楚,請使用者升級 core 或換一個相容版本的 extension。
//
// 與 src/ext/capabilities.ts 的刻意區隔:
//   那支檔案是「provider/callback 層」的型別(core-v2 §2.3/§2.5)—— payment、
//   doc-extraction 等外部服務以 code extension 身分實作 UploadProvider /
//   ContentProvider / CallbackReceiver,給其他 extension 呼叫用。那是「誰提供了
//   什麼服務」的介面契約,語意上更接近 dependency injection。
//   這支檔案(features.ts)是「這個 core build 本身內建了哪些平台功能」的靜態清單
//   (contents engine、media 欄位、relations、blocks…),語意上更接近 feature flag /
//   版本能力表,只給 declarative manifest 的 install-time 相容性檢查用,兩者名字接近
//   但完全不同層,不可互相取代或合併。

export const CORE_FEATURES = [
  "contents", // 共用 contents engine(types/fields/auto-CRUD)
  "media", // R2 media library + media 欄位
  "relations", // relation/relations 欄位型別
  "blocks", // group/repeater/blocks 結構欄位
  "public-create", // contentType public:true 匿名 POST
  "og-image", // og.image template pipeline
  "webhooks", // manifest `on` hook → webhook actions
  "settings", // extension settings + secret 加密
  "admin-pages", // adminPages 頁面
  "public-routes", // publicRoutes list/detail/form
] as const;

export type CoreFeature = (typeof CORE_FEATURES)[number];

const CORE_FEATURE_SET = new Set<string>(CORE_FEATURES);

/**
 * 回傳 manifest.capabilities 中「這個 core 不支援」的名稱(去重、依原始出現順序)。
 * 空陣列 = 完全相容(或 manifest 根本沒宣告 capabilities)。
 */
export function missingCapabilities(
  required: readonly string[] | undefined,
): string[] {
  if (!required || required.length === 0) return [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const name of required) {
    if (CORE_FEATURE_SET.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    missing.push(name);
  }
  return missing;
}
