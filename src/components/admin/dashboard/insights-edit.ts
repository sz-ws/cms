import type {
  InsightConfigEntry,
  InsightWidgetId,
} from "@/lib/dashboard-insights-config";
import type { WidgetPresetId } from "./widgets/types";

// DashboardInsights 編輯模式的狀態機。抽出來是因為「怎麼離開編輯模式」是這塊唯一
// 會把人卡住的地方:舊版只有存檔成功一條出路,存檔一失敗(editor 角色打 PUT
// /api/settings 必被 403,或單純斷線)就永遠停在「儲存失敗。」,只能整頁重載。
// 現在退出有兩條路 —— 存檔成功、或取消還原,而且 saveError 不擋任何一條。
//
// 純函式擺這裡也順便可測:測試跑在 workerd pool(沒有 DOM,也沒有裝
// testing-library),沒辦法真的點按鈕,只能對狀態轉移下斷言。

export interface InsightsEditState {
  editing: boolean;
  saving: boolean;
  saveError: boolean;
  /** 編輯中的草稿。離開編輯模式時一律回到 server 傳下來的 config。 */
  draft: InsightConfigEntry[];
}

export type InsightsEditAction =
  | { kind: "open" }
  | { kind: "cancel"; config: InsightConfigEntry[] }
  | { kind: "toggle"; id: InsightWidgetId }
  | { kind: "move"; id: InsightWidgetId; dir: -1 | 1 }
  | { kind: "preset"; id: InsightWidgetId; preset: WidgetPresetId }
  | { kind: "saveStarted" }
  | { kind: "saveFailed" }
  | { kind: "saveSucceeded" };

export function initialInsightsEditState(
  config: InsightConfigEntry[],
): InsightsEditState {
  return { editing: false, saving: false, saveError: false, draft: config };
}

function moveEntry(
  draft: InsightConfigEntry[],
  id: InsightWidgetId,
  dir: -1 | 1,
): InsightConfigEntry[] {
  const i = draft.findIndex((entry) => entry.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= draft.length) return draft;
  const next = [...draft];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export function insightsEditReducer(
  state: InsightsEditState,
  action: InsightsEditAction,
): InsightsEditState {
  switch (action.kind) {
    case "open":
      return { ...state, editing: true, saveError: false };
    // 取消 = 丟掉草稿、清掉錯誤、離開編輯模式。錯誤訊息不該把出口一起帶走。
    case "cancel":
      return {
        editing: false,
        saving: false,
        saveError: false,
        draft: action.config,
      };
    case "toggle":
      return {
        ...state,
        draft: state.draft.map((entry) =>
          entry.id === action.id ? { ...entry, enabled: !entry.enabled } : entry,
        ),
      };
    case "move":
      return { ...state, draft: moveEntry(state.draft, action.id, action.dir) };
    case "preset":
      return {
        ...state,
        draft: state.draft.map((entry) =>
          entry.id === action.id ? { ...entry, preset: action.preset } : entry,
        ),
      };
    case "saveStarted":
      return { ...state, saving: true, saveError: false };
    // 失敗時刻意留在編輯模式(草稿還在,重試一次就好),但取消永遠可用。
    case "saveFailed":
      return { ...state, saving: false, saveError: true };
    case "saveSucceeded":
      return { ...state, saving: false, saveError: false, editing: false };
  }
}

/**
 * 只有「原本隱藏 → 現在顯示」才需要 server 重新 render:排序 / preset / 隱藏都由
 * 草稿完整反映,唯獨被隱藏的 widget 當初在 server 根本沒查資料。
 */
export function needsServerData(
  draft: readonly InsightConfigEntry[],
  config: readonly InsightConfigEntry[],
): boolean {
  return draft.some((entry) => {
    const before = config.find((item) => item.id === entry.id);
    return entry.enabled && before?.enabled === false;
  });
}
