import { AsyncLocalStorage } from "node:async_hooks";
import { cache } from "react";
import {
  levelOf,
  lowerLevel,
  pageRefPath,
  type AccessLevel,
  type AccessMap,
  type GrantedLevel,
} from "@/ext/admin-access";

// 1.50.0:「這個 request 在哪一個後台頁 / 哪一條 API 裡」—— 自訂角色的授權憑據。
//
// 自訂角色在被授權的地方以管理者身分執行(插件的 handler 與頁面照舊呼叫
// requireAuth("admin")、看 role === "admin"),其餘地方是一般登入者。getSessionUser
// (lib/auth.ts)問這裡:目前有沒有人開了門、門要求哪一級、這個角色有沒有到。
//
// 只有明確的門會開:
//   - API:/api/ext dispatch 與媒體 API 用 runWithAccessScope() 包住 handler
//     (AsyncLocalStorage,跟著 handler 的 await 走)。
//   - 頁面:頁面守門(lib/access-guards.ts)在 render 開頭 enterAccessScope()
//     (React cache():一個 RSC request 一份,子元件在守門之後才 render)。
// 沒有門的地方(設定、成員、所有 core API)就沒有 scope,自訂角色一律是一般登入者。
// 不讀任何 request header —— header 是用戶端可以偽造的。

export interface AccessScope {
  /** 這扇門要求的權限。 */
  needed: GrantedLevel;
  /** 這個角色在這扇門的權限(依 access 算;純函式)。 */
  levelOf: (access: AccessMap) => AccessLevel;
}

const storage = new AsyncLocalStorage<AccessScope>();

// React cache():RSC render 期間一個 request 一個盒子;不在 render 裡(route handler、
// 測試)每次呼叫都拿到新盒子,也就是「沒有門」—— 失敗的方向是關著。
const renderScope = cache((): { current: AccessScope | null } => ({ current: null }));

/** 關著的門:自訂角色在裡面一律不是管理者。 */
const CLOSED: AccessScope = { needed: "edit", levelOf: () => "none" };

export function runWithAccessScope<T>(scope: AccessScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function enterAccessScope(scope: AccessScope): void {
  renderScope().current = scope;
}

export function currentAccessScope(): AccessScope | null {
  return storage.getStore() ?? renderScope().current;
}

/**
 * 把目前的門縮到某一頁。一條 API 服務好幾頁、不同動作屬於不同頁時(例:同一條 route
 * 核實收款也登記出貨),handler 用它包住那個動作:fn 裡的 requireAuth / getSessionUser
 * 只在自訂角色對「這一頁」也有外層那扇門要求的權限時才是管理者。
 *
 * 只會縮小:外層沒開門(或 pageRef 格式不對)時這裡是關著的;外層要求編輯,這一頁也要
 * 編輯。預設角色(admin / editor / guest)完全不受影響。
 * pageRef 格式同 AdminPage.accessAs:"<extId>" 或 "<extId>/<slug>"。
 *
 * 也適合 provider:別的插件呼叫進來時,handler 開的是呼叫者那一頁的門,provider 在自己
 * 的 requireAuth("admin") 外包一層,就要求自己那一頁也有授權。
 */
export function withinAdminPage<T>(pageRef: string, fn: () => T): T {
  const outer = currentAccessScope();
  const path = pageRefPath(pageRef);
  const scope: AccessScope =
    outer && path
      ? {
          needed: outer.needed,
          levelOf: (access) => lowerLevel(outer.levelOf(access), levelOf(access, path)),
        }
      : CLOSED;
  return storage.run(scope, fn);
}
