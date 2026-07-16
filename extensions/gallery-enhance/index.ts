import { overrideRegistry } from "@/ext/overrides";
import { surfaceIds } from "@/ext/dx/surfaces";
import { GalleryDetailOverride } from "./GalleryDetailOverride";

// core-v2 §3.6 DEMO ONLY —— progressive extension「程式碼強化層」的登記入口。
//
// 這裡不匯出一個新的 Extension —— seeded 宣告式 `gallery` extension 已提供 baseline
// (content type + 4 個泛用 surface)。此模組只是 gallery 的「code enhancement」:在
// module load 時把一個自訂 detail 元件登記進 overrideRegistry。interpret.tsx 為
// gallery 的 public detail surface 產生元件時,會查到此 override 並改用它;其餘 surface
// 仍用泛用 baseline。
//
// 「build+deploy 才點亮」的機制:此模組經 extensions/registry.ts 的 side-effect import
// 被拉進 bundle。移除那行 import(或註解掉下方 register)= 移除 override = 該 surface
// 退回泛用 baseline,同一份 gallery 資料照樣渲染(§3.6 back-compat / no data loss)。

const GALLERY_EXT_ID = "gallery";
const GALLERY_ITEM_TYPE = `${GALLERY_EXT_ID}.item`;
const DETAIL_SURFACE = surfaceIds.publicDetail(GALLERY_ITEM_TYPE);

/**
 * 登記 gallery 的所有程式碼強化(v1:只 detail surface)。於 module load 時呼叫一次。
 * 冪等:先以 has() 檢查是否已登記再登記 —— dev HMR 會重新 evaluate 本 code 模組,而
 * overrideRegistry singleton 的狀態跨 hot-reload 保留,若無此守衛,重新 evaluate 就會
 * 撞上 register() 的重複檢查而 throw。cold start(Workers 部署)每模組僅 evaluate 一次,
 * 守衛為 no-op。registry.register() 對「不同 call site 的重複」仍維持嚴格。
 */
export function registerGalleryEnhancements(): void {
  if (overrideRegistry.has(GALLERY_EXT_ID, DETAIL_SURFACE)) return;
  overrideRegistry.register(
    GALLERY_EXT_ID,
    DETAIL_SURFACE,
    "detail",
    GalleryDetailOverride,
  );
}

// module load 時立即登記(side-effect import 由 extensions/registry.ts 觸發)。
registerGalleryEnhancements();
