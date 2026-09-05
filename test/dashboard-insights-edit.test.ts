import { describe, expect, it } from "vitest";
import {
  initialInsightsEditState,
  insightsEditReducer,
  needsServerData,
  type InsightsEditAction,
  type InsightsEditState,
} from "../src/components/admin/dashboard/insights-edit";
import type { InsightConfigEntry } from "../src/lib/dashboard-insights-config";

// DashboardInsights 是 client component,而整個 suite 跑在 workerd pool(沒有 DOM,
// 也沒有裝 testing-library),點不到按鈕。編輯模式真正會把人卡住的是狀態轉移本身,
// 所以斷言下在抽出來的 reducer 上:存檔失敗後還出得去、出去之後草稿回到 server 值。

const SERVER_CONFIG: InsightConfigEntry[] = [
  { id: "activity", enabled: true },
  { id: "distribution", enabled: true },
  { id: "storage", enabled: false },
  { id: "database", enabled: true },
];

function run(
  state: InsightsEditState,
  ...actions: InsightsEditAction[]
): InsightsEditState {
  return actions.reduce(insightsEditReducer, state);
}

describe("dashboard insights edit state", () => {
  it("lets a failed save be cancelled out of, restoring the server config", () => {
    const start = initialInsightsEditState(SERVER_CONFIG);

    // 編輯 → 改了東西 → 送出 → 失敗(editor 角色打 PUT /api/settings 必吃 403)。
    const failed = run(
      start,
      { kind: "open" },
      { kind: "toggle", id: "activity" },
      { kind: "preset", id: "distribution", preset: "bar-list" },
      { kind: "saveStarted" },
      { kind: "saveFailed" },
    );

    expect(failed.saveError).toBe(true);
    expect(failed.saving).toBe(false);
    // 刻意留在編輯模式:草稿還在,重試一次就好。
    expect(failed.editing).toBe(true);
    expect(failed.draft[0]).toEqual({ id: "activity", enabled: false });

    // 取消是唯一與存檔無關的出口 —— 錯誤訊息不會把它一起鎖住。
    const cancelled = insightsEditReducer(failed, {
      kind: "cancel",
      config: SERVER_CONFIG,
    });

    expect(cancelled.editing).toBe(false);
    expect(cancelled.saveError).toBe(false);
    expect(cancelled.saving).toBe(false);
    expect(cancelled.draft).toEqual(SERVER_CONFIG);
  });

  it("does not mutate the server config while editing", () => {
    const snapshot = structuredClone(SERVER_CONFIG);
    run(
      initialInsightsEditState(SERVER_CONFIG),
      { kind: "open" },
      { kind: "toggle", id: "storage" },
      { kind: "move", id: "database", dir: -1 },
    );
    expect(SERVER_CONFIG).toEqual(snapshot);
  });

  it("clears the error and leaves edit mode on a successful save", () => {
    const saved = run(
      initialInsightsEditState(SERVER_CONFIG),
      { kind: "open" },
      { kind: "saveStarted" },
      { kind: "saveFailed" },
      { kind: "saveStarted" },
      { kind: "saveSucceeded" },
    );

    expect(saved.editing).toBe(false);
    expect(saved.saveError).toBe(false);
    expect(saved.saving).toBe(false);
  });

  it("reopening edit mode drops a stale error", () => {
    const reopened = run(
      initialInsightsEditState(SERVER_CONFIG),
      { kind: "open" },
      { kind: "saveStarted" },
      { kind: "saveFailed" },
      { kind: "cancel", config: SERVER_CONFIG },
      { kind: "open" },
    );

    expect(reopened.editing).toBe(true);
    expect(reopened.saveError).toBe(false);
  });

  it("moves entries within bounds only", () => {
    const state = run(
      initialInsightsEditState(SERVER_CONFIG),
      { kind: "open" },
      { kind: "move", id: "activity", dir: -1 },
      { kind: "move", id: "database", dir: 1 },
    );
    expect(state.draft.map((entry) => entry.id)).toEqual(
      SERVER_CONFIG.map((entry) => entry.id),
    );

    const moved = insightsEditReducer(state, {
      kind: "move",
      id: "storage",
      dir: -1,
    });
    expect(moved.draft.map((entry) => entry.id)).toEqual([
      "activity",
      "storage",
      "distribution",
      "database",
    ]);
  });

  it("only asks the server for data when a hidden widget becomes visible", () => {
    const shown = run(initialInsightsEditState(SERVER_CONFIG), {
      kind: "toggle",
      id: "storage",
    });
    expect(needsServerData(shown.draft, SERVER_CONFIG)).toBe(true);

    const hidden = run(initialInsightsEditState(SERVER_CONFIG), {
      kind: "toggle",
      id: "activity",
    });
    expect(needsServerData(hidden.draft, SERVER_CONFIG)).toBe(false);

    const reordered = run(initialInsightsEditState(SERVER_CONFIG), {
      kind: "move",
      id: "database",
      dir: -1,
    });
    expect(needsServerData(reordered.draft, SERVER_CONFIG)).toBe(false);
  });
});
