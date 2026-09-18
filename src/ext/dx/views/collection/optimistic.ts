// 批次動作的樂觀更新(BulkActionBar → CollectionTable / CollectionGrid)。
//
// 按下去的當下就把列畫成結果:改狀態的列換上新狀態並標 pending(淡一點,表示還在存),
// 刪除的列直接拿掉。server 回來後由 router.refresh() 帶回的新資料接手;失敗時
// transition 結束,useOptimistic 自動退回 server 給的原列表。

export type BulkAction =
  | { kind: "status"; ids: readonly string[]; status: "published" | "draft" }
  | { kind: "delete"; ids: readonly string[] };

/** 批次動作碰得到的最小形狀:table 的列與 grid 的卡都符合。 */
export interface BulkTarget {
  id: string;
  status: string;
  /** 樂觀套上、server 還沒確認。 */
  pending?: boolean;
}

export function applyBulkAction<R extends BulkTarget>(
  rows: readonly R[],
  action: BulkAction,
): R[] {
  const ids = new Set(action.ids);
  if (action.kind === "delete") return rows.filter((r) => !ids.has(r.id));
  return rows.map((r) =>
    ids.has(r.id) ? { ...r, status: action.status, pending: true } : r,
  );
}
