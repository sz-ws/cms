// 1.60.0:「給 AI 的說明」—— 管理員寫給 AI 的站台規則(語氣、命名、該用哪些分類)。
// 設定頁在 AI 那張卡(settings.ts 的 core.ai.notes);src/ext/agent-guide.ts 把它接在
// 內建說明後面,送進後台助理的 system prompt 與 AI 連線的 instructions。
//
// 純模組:settings.ts 與 agent-guide.ts 都要用這兩個常數,放在任何一邊都會多拖一串相依。

export const AI_NOTES_SETTING = "core.ai.notes";

/**
 * 字數上限(code point)。設定頁輸入框與伺服器都擋(setting-validation 的 textarea
 * maxLength);讀出來時再截一次,手改 DB 的值也不會撐大每一次對話的 prompt。
 */
export const AI_NOTES_MAX_LENGTH = 2_000;

/**
 * 存著的值 → 可以放進 prompt 的文字。不是字串(沒設定、或設定頁把像 JSON 的輸入 parse
 * 成物件)就轉回文字;空白收掉;超過上限截斷。
 */
export function normalizeAiNotes(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value === undefined || value === null) {
    text = "";
  } else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      text = "";
    }
  }
  const trimmed = text.replace(/\r\n?/g, "\n").trim();
  return Array.from(trimmed).slice(0, AI_NOTES_MAX_LENGTH).join("");
}
