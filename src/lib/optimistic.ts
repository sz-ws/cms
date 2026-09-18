// useOptimistic 的 reducer 包裝:同一份 state 套同一個 action,永遠拿回同一個結果物件。
//
// 為什麼需要:transition 還沒結束的每一次 render,React 都會拿 passthrough(server 給的
// 列表)把還在等的 action 重新套一遍 —— reducer 每次都回傳新陣列、新的那一列。拿這個
// 結果做 identity 比較的地方(sheet 用 `row !== held` 留住最後一筆、useMemo 的依賴)
// 就會每次 render 都以為「變了」;sheet 那種在 render 中 setState 的寫法會直接無限
// re-render。以 (state, action) 的參照做快取之後,結果只在 server 資料或 action 真的
// 換了時才換,呼叫端照常寫 useOptimistic 即可。
//
// action 必須是物件(WeakMap 的 key);state 也是。WeakMap 讓舊列表與已結束的 action
// 跟著被回收,不會累積。

export function stableReducer<S extends object, A extends object>(
  reduce: (state: S, action: A) => S,
): (state: S, action: A) => S {
  const cache = new WeakMap<S, WeakMap<A, S>>();
  return (state, action) => {
    let byAction = cache.get(state);
    if (!byAction) {
      byAction = new WeakMap();
      cache.set(state, byAction);
    }
    let next = byAction.get(action);
    if (next === undefined) {
      next = reduce(state, action);
      byAction.set(action, next);
    }
    return next;
  };
}
