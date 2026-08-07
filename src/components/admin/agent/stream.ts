import type { AgentLoopEvent } from "@/ext/agent-loop";

// docs/spec-admin-agent.md §5(1.32.0 streaming):面板的串流層,抽成純函式。
//
// ── 為什麼又是一個沒有 React 的檔案 ─────────────────────────────────────────
// 與 transcript.ts 同一個理由,只是這裡的失敗模式更隱蔽:SSE 的 frame 邊界不保證
// 對齊網路 chunk。一段 `event: text_delta\ndata: {"t…` 很可能被切成兩次 read,而
// 「大部分時候剛好對齊」讓這個錯誤在開發機上永遠不出現,只在正式環境的長回覆裡
// 偶爾吃掉一個字。這種東西不能靠眼睛驗,要用測試釘。
//
// ── 分工的鐵律 ──────────────────────────────────────────────────────────────
// 這裡的 StreamingState 是**暫態顯示**,不是真相:transcript 一律由最後那個
// outcome 事件經 transcript.ts 的 applyChatOutcome 組裝。delta 拼出來的字與
// outcome 裡的正式內容有任何差異時,以 outcome 為準 —— 面板在收到 outcome 的當下
// 就把整段暫態內容丟掉,換成正式的條目。
//
// 這不是潔癖:delta 只帶「模型說了什麼」,outcome 還帶著工具跑了幾個、有沒有失敗、
// 有沒有被截斷、以及要送回上游的那份 messages。拿 delta 當真相等於讓畫面上的對話
// 與送回上游的對話分岔。

// ---------------------------------------------------------------------------
// SSE frame 切割
// ---------------------------------------------------------------------------

export interface SseFrame {
  /** `event:` 行;SSE 規範的預設是 "message"(本端點一律具名,留著是為了不吞掉
   *  任何非預期的 frame)。 */
  event: string;
  /** `data:` 行(多行依規範以 "\n" 接回)。 */
  data: string;
}

/**
 * 從累積的 buffer 裡切出所有**完整**的 frame,並回傳還沒切完的殘段。
 *
 * 呼叫端把 rest 留著、接上下一個 chunk 再呼叫一次。純函式:同樣的 buffer 永遠
 * 得到同樣的切法,測試可以直接餵各種難看的切點。
 *
 * 沒有 data 行的 frame(SSE comment、心跳)回傳時被略過 —— 它們不是事件。
 */
export function splitSseFrames(buffer: string): {
  frames: SseFrame[];
  rest: string;
} {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames: SseFrame[] = [];
  let rest = normalized;
  for (;;) {
    const idx = rest.indexOf("\n\n");
    if (idx === -1) break;
    const raw = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const frame = parseSseFrame(raw);
    if (frame) frames.push(frame);
  }
  return { frames, rest };
}

function parseSseFrame(raw: string): SseFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

// ---------------------------------------------------------------------------
// 串流中的顯示狀態
// ---------------------------------------------------------------------------

/**
 * 目前這一刻的狀態行。**靜態文字**,沒有動畫 —— 這個後台的等待語彙是
 * RingDot + 一句話(docs/admin-design-language.md),而 pulsing / 呼吸 / 打字游標
 * 閃爍是明列的紅線。文字本身在長就是進度訊號,不需要再加一個會動的東西。
 */
export type StreamingStatus =
  | { kind: "thinking" }
  | { kind: "tool"; name: string };

export interface StreamingState {
  /** 這一輪目前為止串流出來的文字(暫態,見檔頭)。 */
  text: string;
  /** 最近一次 step 事件的編號(1-based;0 = 還沒開始)。 */
  step: number;
  /** null = 正在吐字,狀態行讓位給文字本身。 */
  status: StreamingStatus | null;
}

export function emptyStreaming(): StreamingState {
  return { text: "", step: 0, status: null };
}

/**
 * 套用一個 loop 事件。
 *
 * 段落規則:新的一步開始時,若上一步已經說過話就補一個空行 —— 中間步驟的發言
 * (「我先查一下訂單」)與下一步的內容是兩段話,黏在一起會讀成一句。不清空是
 * 刻意的:已經看到的字不該在畫面上消失,那比多一個空行更讓人困惑。
 */
export function applyLoopEvent(
  state: StreamingState,
  event: AgentLoopEvent,
): StreamingState {
  switch (event.type) {
    case "step":
      return {
        text: state.text.length > 0 ? `${state.text}\n\n` : "",
        step: event.step,
        status: { kind: "thinking" },
      };
    case "text_delta":
      return { ...state, text: state.text + event.text, status: null };
    case "tool":
      return { ...state, status: { kind: "tool", name: event.name } };
    case "tool_done":
      // 工具跑完但下一步的 step 事件還沒到 —— 回到「思考中」而不是留在工具名上,
      // 否則畫面會停在一個已經結束的動作上。成敗不在這裡表達:它會出現在
      // outcome 的 toolCalls 摺疊區,那份是有紀錄的。
      return { ...state, status: { kind: "thinking" } };
  }
}
