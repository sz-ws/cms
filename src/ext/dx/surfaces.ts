// core-v2 §3.6:progressive override surface-id scheme。
//
// 每個宣告式 content type 的可覆寫「表面（surface）」都有一個穩定字串 id,供程式碼強化層
// 在 override registry(src/ext/overrides.ts)以 (extId, surfaceId) 精確登記自訂元件。
//
// v1 只涵蓋 4 個 view surface:
//   admin:<contentType>:collection   → 泛用 CollectionView 的替代
//   admin:<contentType>:form         → 泛用 FormViewPage 的替代
//   public:<contentType>:list        → 泛用 ListView 的替代
//   public:<contentType>:detail      → 泛用 DetailView 的替代
//
// 公開 form 雖然現已改為共用 FormView(public mode),但目前仍不納入 progressive
// override surface taxonomy —— 先把 special-case view 移掉、共用 field system 即可,
// surface 正規化留待下一步再做。
//
// contentType = 完整 type key「<extId>.<name>」(如 "gallery.item"),與
// ContentTypeDef.type / relation `to` 目標一致。以完整 key 為鍵可讓同一 extId 的多個
// content type 各自獨立覆寫,且與資料層命名一致。
//
// dashboard-block / extra-API-route 覆寫為 §3.6 的 follow-up,v1 不含(見 SURFACE_KINDS)。
//
// 1.51.0:另有**插件層級**的 surface —— 不屬於某個 content type,每個插件一個,
// 形狀只有兩段「<kind>:<view>」:
//   public:scripts                   → 宣告式插件 manifest.scripts 的替代(見 ./scripts-widget.tsx)
// 編進網站的程式碼登記了它,前台就改掛那個元件,manifest 的 script 一段都不輸出。

/** surface 的兩大分類:後台 admin 頁 vs 公開 public 路由。 */
export const SURFACE_KINDS = ["admin", "public"] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/** 每個 kind 底下的 view 種類(v1:4 個 view surface)。 */
export const ADMIN_VIEWS = ["collection", "form"] as const;
export const PUBLIC_VIEWS = ["list", "detail"] as const;

/** 1.51.0:插件層級(沒有 content type)的 public view。 */
export const EXTENSION_VIEWS = ["scripts"] as const;

export type AdminView = (typeof ADMIN_VIEWS)[number];
export type PublicView = (typeof PUBLIC_VIEWS)[number];
export type ExtensionView = (typeof EXTENSION_VIEWS)[number];
export type SurfaceView = AdminView | PublicView | ExtensionView;

/** content type 層級的 surface(4 個 view surface)。 */
export interface ContentSurfaceRef {
  kind: SurfaceKind;
  /** 完整 content type key「<extId>.<name>」。 */
  contentType: string;
  view: AdminView | PublicView;
}

/** 1.51.0:插件層級的 surface —— 每個插件一個,沒有 content type。 */
export interface ExtensionSurfaceRef {
  kind: "public";
  contentType?: undefined;
  view: ExtensionView;
}

/** 一個 surface 的結構化描述(build/parse 兩端共用)。 */
export type SurfaceRef = ContentSurfaceRef | ExtensionSurfaceRef;

const SEP = ":";

/**
 * 組出穩定的 surfaceId 字串,形狀「<kind>:<contentType>:<view>」。
 * 例:buildSurfaceId({ kind:"public", contentType:"gallery.item", view:"detail" })
 *     → "public:gallery.item:detail"
 *
 * 註:contentType 內含一個「.」分隔 extId 與 name,但不含「:」,故用「:」當外層分隔
 * 不會與 contentType 內部碰撞(見 parseSurfaceId 的重組邏輯)。
 */
export function buildSurfaceId(ref: SurfaceRef): string {
  if (ref.contentType === undefined) return `${ref.kind}${SEP}${ref.view}`;
  return `${ref.kind}${SEP}${ref.contentType}${SEP}${ref.view}`;
}

/** 便捷 helpers —— 每個 surface 各一,避免呼叫端手拼字串出錯。 */
export const surfaceIds = {
  adminCollection: (contentType: string): string =>
    buildSurfaceId({ kind: "admin", contentType, view: "collection" }),
  adminForm: (contentType: string): string =>
    buildSurfaceId({ kind: "admin", contentType, view: "form" }),
  publicList: (contentType: string): string =>
    buildSurfaceId({ kind: "public", contentType, view: "list" }),
  publicDetail: (contentType: string): string =>
    buildSurfaceId({ kind: "public", contentType, view: "detail" }),
  /** 1.51.0:"public:scripts"。鍵是 (extId, surfaceId),所以不帶參數也是每個插件一個。 */
  publicScripts: (): string => buildSurfaceId({ kind: "public", view: "scripts" }),
} as const;

function isSurfaceKind(v: string): v is SurfaceKind {
  return (SURFACE_KINDS as readonly string[]).includes(v);
}

function isContentView(kind: SurfaceKind, v: string): v is AdminView | PublicView {
  const views: readonly string[] =
    kind === "admin" ? ADMIN_VIEWS : PUBLIC_VIEWS;
  return views.includes(v);
}

function isExtensionView(v: string): v is ExtensionView {
  return (EXTENSION_VIEWS as readonly string[]).includes(v);
}

/**
 * 解析 surfaceId → SurfaceRef,或 null(格式不合法 / kind·view 不匹配)。
 * 純字串切分,無 regex(03 §:ReDoS 面)。middle 段即完整 contentType(可含「.」)。
 * 兩段的只收插件層級的 view(public:scripts);content type 的 view 一定要三段。
 */
export function parseSurfaceId(surfaceId: string): SurfaceRef | null {
  const first = surfaceId.indexOf(SEP);
  const last = surfaceId.lastIndexOf(SEP);
  if (first <= 0) return null;
  if (first === last) {
    const view = surfaceId.slice(first + 1);
    return surfaceId.slice(0, first) === "public" && isExtensionView(view)
      ? { kind: "public", view }
      : null;
  }
  const kind = surfaceId.slice(0, first);
  const contentType = surfaceId.slice(first + 1, last);
  const view = surfaceId.slice(last + 1);
  if (contentType.length === 0 || view.length === 0) return null;
  if (!isSurfaceKind(kind)) return null;
  if (!isContentView(kind, view)) return null;
  return { kind, contentType, view };
}
