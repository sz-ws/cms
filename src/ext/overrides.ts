import type { ComponentType } from "react";
import type { CollectionViewProps } from "./dx/views/CollectionView";
import type { FormViewPageProps } from "./dx/views/FormViewPage";
import type { ListViewProps } from "./dx/views/ListView";
import type { DetailViewProps } from "./dx/views/DetailView";
import { parseSurfaceId } from "./dx/surfaces";

// core-v2 §3.6:code-override registry(progressive extensions 的核心)。
//
// 一個 module-level singleton,與 ProviderRegistry(§2.2)同哲學:程式碼強化層在 module
// load 時把自訂元件登記進來,鍵為 (extId, surfaceId)。interpret.tsx 在為某 surface 產生
// 元件時先查此 registry —— 有登記 → 用自訂元件;無 → 泛用宣告式 baseline(§3.6 fallback)。
//
// 「requires a rebuild+deploy」的機制:Workers 無法 runtime-load 程式碼,故登記只能發生在
// 已編譯進 bundle 的 code 模組載入時(經 extensions/registry.ts import 鏈)。因此:建置+部署
// 才會「點亮」override;在那之前使用者拿到的是泛用 baseline。這與 ProviderRegistry 的
// 「code extension 的 provides 於載入時註冊」完全對稱,只是把粒度下推到 per-extension、
// per-surface。
//
// Props 契約(§3.6):每個 surface 的 override 元件收到與泛用 view 相同的 props,作者得以
// 在同一份資料/handler 之上渲染自訂 UI。下方 SurfaceProps 把 surfaceId 的 view 尾段對應到
// 對應 view 的已匯出 props 型別,讓 register() 具型別安全性。
//
// v1 範圍:只 4 個 view surface(admin collection/form、public list/detail)。
// 公開 form 雖已共用 FormView(public mode),但尚未納入 override taxonomy。
// dashboard-block / extra-API-route override 為 §3.6 follow-up,此處不建。
// 一個 (extId, surfaceId) 僅一個 override(重複登記 → throw,避免 code 層自我覆寫的靜默 bug)。

/** 各 v1 surface 的 override 元件 props —— 一律等同泛用 view 的 props(§3.6 契約)。 */
export type CollectionSurfaceProps = CollectionViewProps;
export type FormSurfaceProps = FormViewPageProps;
export type ListSurfaceProps = ListViewProps;
export type DetailSurfaceProps = DetailViewProps;

/**
 * 依 surfaceId 的 view 尾段對應到 props 型別。key 為 view 名(collection/form/list/detail)。
 * register<K>() 用它把「哪個 surface」與「該 surface 元件的 props」在編譯期綁定。
 */
export interface SurfacePropsByView {
  collection: CollectionSurfaceProps;
  form: FormSurfaceProps;
  list: ListSurfaceProps;
  detail: DetailSurfaceProps;
}

export type SurfaceViewKey = keyof SurfacePropsByView;

/** 某 surface 的 override 元件型別(server component,收該 surface 的泛用 props)。 */
export type OverrideComponent<K extends SurfaceViewKey> = ComponentType<
  SurfacePropsByView[K]
>;

export interface OverrideRegistry {
  /**
   * 登記一個 (extId, surfaceId) 的 override 元件。view 型別參數 K 綁定 props 契約。
   * 重複 (extId, surfaceId) → throw(code 層設定錯誤應在載入期即暴露)。
   */
  register<K extends SurfaceViewKey>(
    extId: string,
    surfaceId: string,
    view: K,
    component: OverrideComponent<K>,
  ): void;
  /**
   * 查某 (extId, surfaceId) 是否有 override 元件。無 → null(呼叫端退回 baseline)。
   * 回傳以未型別化的 ComponentType<unknown-ish>,由 interpret.tsx 的 resolve helper
   * 在已知 surface 語境下收斂到正確 props(見 interpret.tsx resolveSurface)。
   */
  get(extId: string, surfaceId: string): ComponentType<never> | null;
  /**
   * (extId, surfaceId) 是否已登記。供強化模組做「已登記則跳過」的冪等自我登記
   * (dev HMR 下 code 模組會被重新 evaluate,而本 singleton 的狀態跨 hot-reload 保留;
   * 沒有這個守衛,重新 evaluate 就會撞上 register() 的重複檢查而 throw)。register()
   * 本身維持嚴格(不同 call site 重複登記 = 程式錯誤,應暴露)。
   */
  has(extId: string, surfaceId: string): boolean;
  /** 該 extId 已登記的 surfaceId 清單(除錯 / 文件用途)。 */
  list(extId: string): string[];
}

interface StoredOverride {
  // 以最寬的 component 型別存放;型別安全在 register()(輸入端)與 interpret.tsx 的
  // resolve helper(消費端,已知 view→props)兩處各自保證,不放寬實際約束。
  component: ComponentType<never>;
}

class OverrideRegistryImpl implements OverrideRegistry {
  // key = `${extId}\u0000${surfaceId}`(用 NUL 分隔,extId/surfaceId 皆不含 NUL)。
  private readonly byKey = new Map<string, StoredOverride>();

  private static keyOf(extId: string, surfaceId: string): string {
    return `${extId}\u0000${surfaceId}`;
  }

  register<K extends SurfaceViewKey>(
    extId: string,
    surfaceId: string,
    view: K,
    component: OverrideComponent<K>,
  ): void {
    // Phase E §9: cross-check surfaceId's own view segment against the typed
    // `view` param the caller passed (which also picks the props contract via
    // K). Without this, a call site could pass a surfaceId whose embedded view
    // disagrees with `view`/`component`'s actual props shape — e.g. registering
    // a DetailView-shaped component under a surfaceId ending in ":form" — and
    // resolveSurface (interpret.tsx) would hand the wrong props to the wrong
    // generic view's slot at render time.
    const parsed = parseSurfaceId(surfaceId);
    if (!parsed || parsed.view !== view) {
      throw new Error(
        `[overrides] surfaceId "${surfaceId}" view segment does not match registered view "${view}"`,
      );
    }

    const key = OverrideRegistryImpl.keyOf(extId, surfaceId);
    if (this.byKey.has(key)) {
      throw new Error(
        `[overrides] duplicate override for ext="${extId}" surface="${surfaceId}"`,
      );
    }
    // K 已在輸入端保證 component 的 props 與 surface 相符;存放時抹除到最寬型別。
    this.byKey.set(key, {
      component: component as unknown as ComponentType<never>,
    });
  }

  get(extId: string, surfaceId: string): ComponentType<never> | null {
    const entry = this.byKey.get(OverrideRegistryImpl.keyOf(extId, surfaceId));
    return entry ? entry.component : null;
  }

  has(extId: string, surfaceId: string): boolean {
    return this.byKey.has(OverrideRegistryImpl.keyOf(extId, surfaceId));
  }

  list(extId: string): string[] {
    const prefix = `${extId}\u0000`;
    const out: string[] = [];
    for (const key of this.byKey.keys()) {
      if (key.startsWith(prefix)) out.push(key.slice(prefix.length));
    }
    return out;
  }
}

/**
 * Module-level singleton。code 強化層於載入時 import 並呼叫 register();interpret.tsx
 * 於渲染每個 surface 時呼叫 get()。與 ProviderRegistry 一樣是「build 進 bundle 才存在」。
 */
export const overrideRegistry: OverrideRegistry = new OverrideRegistryImpl();
