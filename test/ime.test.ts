import { describe, it, expect } from "vitest";

import { isImeKeyEvent } from "../src/lib/ime";

// 輸入法組字期間的 Enter 歸誰(src/lib/ime.ts)。
//
// 這一檔釘的是那三個訊號**各自單獨成立**就足以擋下送出。實測(Suko,2026-08-07)
// 的症狀是打注音選字時按 Enter,候選字被確定的同時整句話也被送出去了 —— 而那顆
// Enter 在不同瀏覽器留下的痕跡不一樣:Chrome 給 isComposing,Safari 在確定字那一次
// 已經是 isComposing:false、只剩 keyCode 229。少看任何一個都會漏掉一半的使用者。
//
// 這裡測的是純函式那一半;useImeGuard 自記的第三個訊號需要 React 與真的
// composition 事件,workerd 裡沒有 DOM,測不到(見 ime.ts 檔頭)。

/** 只帶這支函式讀得到的那幾個欄位 —— 其餘的 KeyboardEvent 表面與判斷無關。 */
function keyEvent(over: {
  key?: string;
  isComposing?: boolean;
  keyCode?: number;
}): Parameters<typeof isImeKeyEvent>[0] {
  return {
    key: over.key ?? "Enter",
    keyCode: over.keyCode ?? 13,
    nativeEvent: { isComposing: over.isComposing ?? false },
  } as unknown as Parameters<typeof isImeKeyEvent>[0];
}

describe("isImeKeyEvent", () => {
  it("一般的 Enter → 不是輸入法的(照常送出)", () => {
    expect(isImeKeyEvent(keyEvent({}))).toBe(false);
  });

  it("isComposing → 是輸入法的(Chrome / Firefox 組字中)", () => {
    expect(isImeKeyEvent(keyEvent({ isComposing: true }))).toBe(true);
  });

  it("keyCode 229 → 是輸入法的,即使 isComposing 已經是 false", () => {
    // Safari 在「確定候選字」那一次先送 compositionend 再送 keydown,
    // 所以只看 isComposing 會把那顆 Enter 當成送出。
    expect(isImeKeyEvent(keyEvent({ isComposing: false, keyCode: 229 }))).toBe(true);
  });

  it("非 Enter 的按鍵也照樣認得出組字中(↑↓ 是在翻候選清單)", () => {
    expect(isImeKeyEvent(keyEvent({ key: "ArrowDown", isComposing: true }))).toBe(true);
  });

  it("nativeEvent 沒有 isComposing 這個鍵時不會炸,退回看 keyCode", () => {
    const bare = { key: "Enter", keyCode: 13, nativeEvent: {} } as unknown as Parameters<
      typeof isImeKeyEvent
    >[0];
    expect(isImeKeyEvent(bare)).toBe(false);
  });
});
