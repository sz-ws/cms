// 輸入法組字(IME composition)期間的按鍵歸誰。
//
// 注音、拼音、日文、韓文都一樣:打字的過程中有一個**草稿狀態**,使用者按 Enter 是
// 「確定這個候選字」,不是「送出這句話」。同一顆 Enter 在瀏覽器裡只是一次 keydown,
// 元件若不分辨,結果就是使用者一邊選字一邊把半句話送出去 —— 而且愈熟練的中文使用者
// 踩得愈頻繁,因為他們打字時本來就在連續按 Enter 確定字。
//
// 這件事沒有「大致上可行」的寫法,三個訊號都要看,因為沒有一個是全平台可靠的:
//
//   · `isComposing` —— 標準答案,Chrome/Firefox 在組字中的 keydown 上是 true。
//   · `keyCode === 229` —— 舊的、但仍然必要的訊號。Safari 在確定字的那一次
//     **先**送 compositionend **再**送 keydown,那一次的 isComposing 已經是 false,
//     只剩 229 認得出來。
//   · 自己記的 composing 狀態 —— 給前兩個都失準的組合(部分 Android 輸入法)。
//     用 ref 不用 state:它只在事件處理器裡被讀,重新 render 一次沒有意義。
//
// 三個是 OR,不是投票:誤判成「組字中」的代價是使用者多按一次 Enter,誤判成
// 「不是組字」的代價是一句話被送出去而且收不回來。兩邊不對等,所以往保守的那邊倒。

import { useRef } from "react";
import type { KeyboardEvent } from "react";

/** 這一次 keydown 屬於輸入法嗎(不看自記狀態的那一半)。 */
export function isImeKeyEvent(e: KeyboardEvent): boolean {
  // React 的 SyntheticEvent 沒有 isComposing,要往下拿原生事件。
  return (e.nativeEvent as unknown as { isComposing?: boolean }).isComposing === true
    || e.keyCode === 229;
}

/**
 * 組字狀態 + 一個「這次按鍵該不該讓給輸入法」的判斷。
 *
 * 用法是把回傳的三個東西全部接上去 —— 只接 `isComposingKey` 會少掉第三個訊號:
 *
 *     const ime = useImeGuard();
 *     <input
 *       onCompositionStart={ime.onCompositionStart}
 *       onCompositionEnd={ime.onCompositionEnd}
 *       onKeyDown={(e) => {
 *         if (ime.isComposingKey(e)) return;   // ← 第一行,先於任何其他判斷
 *         …
 *       }}
 *     />
 */
export function useImeGuard(): {
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  isComposingKey: (e: KeyboardEvent) => boolean;
} {
  const composing = useRef(false);
  return {
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: () => {
      composing.current = false;
    },
    isComposingKey: (e) => composing.current || isImeKeyEvent(e),
  };
}
