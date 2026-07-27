import type { ComponentType } from "react";

// 1.24.0:`filter:publicWidgets` 的回傳值收斂。
//
// 這支檔案存在的唯一理由是「不信任 filter 的回傳值」。applyFilters 把值交給任意
// extension 的 handler,而 handler 是別人寫的:少寫一個 return 就是 undefined、
// 把 `[...w, X]` 寫成 `X` 就是單一元件、寫成 `{...w, X}` 就是物件。這些在
// src/app/(public)/layout.tsx 直接 `.map()` 全都是 runtime throw,而那個檔是**每一
// 條公開路由**的外框 —— 一個浮層 extension 的手誤會把整個站變成 500。
//
// 所以規則是:外框的失敗模式必須是「少一個浮層」,不是白畫面。

/**
 * 把 filter 回傳值收斂成可安全渲染的元件陣列。
 *
 * 非陣列 → []。陣列內非 function 的項目逐一丟掉(不是整包丟掉:一個 extension
 * push 了壞東西,不該連累其他 extension 的浮層)。
 */
export function normalizePublicWidgets(value: unknown): ComponentType[] {
  if (!Array.isArray(value)) return [];
  return value.filter((w): w is ComponentType => typeof w === "function");
}
