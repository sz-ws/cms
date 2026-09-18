import type { Action, ExtensionRow } from "./ExtensionsManager";

// 已安裝列表的樂觀更新(ExtensionsManager 的 InstalledTab)。狀態 pill 按下去就換,
// router.refresh() 在背景把側欄選單等 layout 一起更新;失敗時 transition 結束,
// 列表自己退回原狀。
//
// uninstall 的結果照 server 的列表形狀(src/app/(admin)/admin/extensions/page.tsx):
// code extension 永遠在列表上(registry 的一員),只是變成未安裝;declarative 的列會消失。

export interface ExtensionsAction {
  id: string;
  action: Action;
}

export function applyExtensionsAction(
  rows: readonly ExtensionRow[],
  { id, action }: ExtensionsAction,
): ExtensionRow[] {
  if (action === "uninstall") {
    return rows.flatMap((r) => {
      if (r.id !== id) return [r];
      if (r.kind === "declarative") return [];
      return [{ ...r, enabled: false, installed: false, issue: null }];
    });
  }
  const enabled = action === "enable";
  // 啟用後可不可用(issue)要等 server 判定;樂觀階段先當作沒問題。啟用一個還沒裝的
  // code extension 會順便安裝(server 端建列),所以 installed 跟著變 true。
  return rows.map((r) =>
    r.id === id
      ? { ...r, enabled, issue: null, installed: r.installed || enabled }
      : r,
  );
}
