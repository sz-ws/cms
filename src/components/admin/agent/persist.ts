import { z } from "zod";
import { askArgsSchema } from "@/ext/agent-ask";
import { codeArgsSchema } from "@/ext/agent-code";
import { agentDisplaySchema } from "@/ext/agent-display";
import type { AgentProposal } from "@/ext/agent-loop";
import type { AiChatContentBlock, AiChatMessage } from "@/ext/providers/ai";
import { withStorage } from "./persist-keys";
import { findDanglingToolUseIds } from "./transcript";
import type { TranscriptState } from "./transcript";

// docs/spec-admin-agent.md §5:面板 transcript 的 localStorage 保存,抽成純函式。
//
// ── 為什麼這件事要一個獨立模組,而不是在元件裡寫兩行 ────────────────────────
// spec §4 把 transcript 交給前端持有(server stateless),所以「重整就沒了」不是
// 一個顯示層的小缺陷 —— 那份對話本來就只存在於這一個分頁的記憶體裡。把它落地到
// localStorage 等於讓一份**上游會驗的資料結構**穿過一個我們控制不了的通道:使用者
// 可以手動改、舊版本可能寫過別的形狀、瀏覽器可能截斷、配額可能爆。
//
// 於是 transcript.ts 檔頭那條鐵律在這裡加倍重要:
//
//     一個 tool_use 必須有對應的 tool_result。
//
// 還原出一份違反它的 state,懲罰一樣是延遲一拍的 —— 畫面看起來正常,直到使用者
// 打下一句話才被上游整份拒收,而且他完全不知道那是「上次的殘骸」造成的。所以本檔
// 的契約寫死成兩句話:
//
//   1. **deserialize 只會回傳合法的 state,或 null。** 沒有第三種結果,不做「盡量
//      修一修」—— 修出來的東西沒有人驗得動,而整包丟掉的代價只是回到空白對話。
//   2. **serialize 只會寫出合法的 state,或什麼都不寫。** 連寫進去的機會都不給,
//      比事後在讀取端補救更省事。
//
// ── 為什麼用 zod 而不是手寫型別守衛 ────────────────────────────────────────
// 這份結構有六種 entry、三種 content block、兩種卡片,手寫守衛的漏網之魚不會炸,
// 只會安靜地讓某個欄位變成 undefined 然後在渲染時才出事。zod 的另一個好處是
// **能直接複用既有的守門**:反問卡吃 agent-ask 的 askArgsSchema、結果卡吃
// agent-display 的 agentDisplaySchema —— 那兩份 schema 已經是 server 端用來擋
// 模型輸出的同一份,不必在這裡重寫一次(重寫的那一份遲早會與本尊漂移)。
//
// bundle:本檔會拉進 zod,所以它的消費者必須都在 /admin/agent 自己的 chunk 上 ——
// AgentPanel(next/dynamic + ssr:false)與 AgentPanelLoader 都是。**登出的清除刻意
// 不從這裡出去**:那個掛在 AdminSidebar,而 AdminSidebar 每一頁 admin 都在,從這裡
// import 會把 zod 釘進 admin 的共用 chunk。key 的形狀與刪除因此住在零相依的
// ./persist-keys(見該檔頭),本檔只留「需要認識 TranscriptState」的那一半。
//
// 純度:不碰 React、不碰 DOM。localStorage 只在最下面兩個 I/O 函式裡出現,而且都
// 經過 persist-keys 的 withStorage —— 上面的 serialize/deserialize 在 workerd 的測試
// 環境裡是純函式,測試因此可以直接餵字串進去比對結果。

// key 的形狀與清除住在 ./persist-keys(零相依)。從這裡原樣再導出,呼叫端不必知道
// 那條 bundle 界線存在;**但 AdminSidebar 必須直接 import persist-keys** —— 見那個
// 檔的檔頭,它就是為了那一個消費者而切出去的。
export {
  AGENT_TRANSCRIPT_KEY_ROOT,
  AGENT_TRANSCRIPT_KEY_PREFIX,
  transcriptStorageKey,
  clearStoredTranscript,
  clearAllStoredTranscripts,
} from "./persist-keys";

/** payload 內的形狀版本。與 key 前綴的版本各管一件事:前綴管「這一批 key 屬於誰」,
 *  這個管「這份 JSON 是哪一代的形狀」。deserialize 檢查的是這一個。 */
const PAYLOAD_VERSION = 1;

/**
 * 單一 key 的字元上限。
 *
 * localStorage 的配額大約 5MB(而且多數瀏覽器算的是 UTF-16 碼元,不是位元組),
 * 那是**整個 origin** 共用的 —— 後台還有別的東西住在裡面。工具結果可以很肥
 * (單筆上限 4,000 字 × 每輪多筆 × 多輪),所以這裡取一個遠低於配額的值:撐爆的
 * 後果不是這一頁壞掉,是同一個站的其他功能開始寫不進去。
 */
export const AGENT_TRANSCRIPT_MAX_CHARS = 512_000;

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

/**
 * content block。
 *
 * 用 z.union 而不是 z.discriminatedUnion 是被 `input` / `args` 這種 `unknown` 欄位
 * 逼的:zod 把 `z.unknown()` 推成**選填**鍵,而 AiChatContentBlock 的 `input` 是
 * 必填(型別上 `unknown` 本來就含 undefined,差別只在「鍵在不在」)。所以 tool_use
 * 這一支尾隨一個 transform 把鍵補成必填 —— 而帶 transform 的成員就不能再當
 * discriminatedUnion 的分支。代價只有錯誤訊息比較不精確,而這裡的錯誤訊息沒有人讀:
 * 驗不過的唯一處置是整包丟掉。
 */
const contentBlockSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z
    .object({
      type: z.literal("tool_use"),
      id: z.string().min(1),
      name: z.string().min(1),
      input: z.unknown(),
    })
    .transform(
      (block): AiChatContentBlock => ({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      }),
    ),
  z.object({
    type: z.literal("tool_result"),
    toolUseId: z.string().min(1),
    content: z.string(),
    isError: z.boolean().optional(),
  }),
]);

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.array(contentBlockSchema),
});

/** 同 contentBlockSchema 的 tool_use:`args` 是 unknown,transform 把鍵補回必填。 */
const proposalSchema = z
  .object({
    toolName: z.string().min(1),
    toolUseId: z.string().min(1),
    args: z.unknown(),
    summary: z.string(),
  })
  .transform(
    (proposal): AgentProposal => ({
      toolName: proposal.toolName,
      toolUseId: proposal.toolUseId,
      args: proposal.args,
      summary: proposal.summary,
    }),
  );

const toolCallLogSchema = z.object({
  toolName: z.string().min(1),
  ok: z.boolean(),
  error: z.string().optional(),
  truncated: z.boolean(),
  // 結果卡:直接吃 server 端那一份守門。這裡不另外定義,因為「什麼樣的 display
  // 畫得出來」的答案只有一個(agent-display.ts 的上限與 .strict()),而它已經寫好了。
  display: agentDisplaySchema.optional(),
});

const askAnswerSchema = z.object({
  choice: z.string().optional(),
  freeText: z.string().optional(),
  values: z.record(z.string(), z.string()).optional(),
});

/** 沙盒卡跑完之後的結果(spec §4.7)。`result` 是任意 JSON 值 —— 那正是重點。 */
const codeOutputSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  note: z.string().optional(),
  logs: z.array(z.string()).optional(),
  error: z.string().optional(),
});

const entryIdSchema = z.string().min(1);

const entrySchema = z.union([
  z.object({ kind: z.literal("user"), id: entryIdSchema, text: z.string() }),
  z.object({ kind: z.literal("assistant"), id: entryIdSchema, text: z.string() }),
  z.object({
    kind: z.literal("toolCalls"),
    id: entryIdSchema,
    calls: z.array(toolCallLogSchema),
  }),
  z.object({
    kind: z.literal("proposal"),
    id: entryIdSchema,
    proposal: proposalSchema,
    resolution: z.enum(["pending", "confirmed", "cancelled"]),
    outcome: z.object({ ok: z.boolean(), detail: z.string() }).optional(),
  }),
  z.object({
    kind: z.literal("ask"),
    id: entryIdSchema,
    // 反問卡吃 agent-ask 的同一份 schema(含「options 與 fields 恰好擇一」那條
    // superRefine)—— 一張兩者都給的卡片畫不出來,存進來的也一樣畫不出來。
    ask: askArgsSchema,
    toolUseId: z.string().min(1),
    resolution: z.enum(["pending", "answered", "dismissed"]),
    answer: askAnswerSchema.optional(),
  }),
  z.object({
    kind: z.literal("code"),
    id: entryIdSchema,
    // 同反問卡:吃 agent-code 的同一份 schema(含 8,000 字上限)。存進來的程式碼
    // 若超過那個上限,還原出來的卡片會顯示一段模型從來沒送過的東西。
    code: codeArgsSchema,
    toolUseId: z.string().min(1),
    resolution: z.enum(["pending", "ran", "declined"]),
    output: codeOutputSchema.optional(),
  }),
  z.object({
    kind: z.literal("notice"),
    id: entryIdSchema,
    tone: z.enum(["maxSteps", "error"]),
    detail: z.string().optional(),
  }),
]);

const stateSchema = z.object({
  messages: z.array(messageSchema),
  entries: z.array(entrySchema),
  pending: proposalSchema.nullable(),
  pendingAsk: z
    .object({ ask: askArgsSchema, toolUseId: z.string().min(1) })
    .nullable(),
  // `.default(null)` 讓 §4.7 之前寫下的 payload 仍然讀得回來。這**不是**跨版本
  // 搬運(見 PAYLOAD_VERSION 的說明):沒有欄位要改寫、沒有一條只跑一次的路徑,
  // 只是「這個鍵不存在」與「這個鍵是 null」本來就同義。為了一個純追加的欄位把
  // 所有人手上的對話丟掉,代價與收穫不成比例。
  pendingCode: z
    .object({ code: codeArgsSchema, toolUseId: z.string().min(1) })
    .nullable()
    .default(null),
  seq: z.number().int().min(0),
});

/** 版本不符 → safeParse 直接失敗 → deserialize 回 null。不做跨版本搬運:一份舊形狀
 *  的對話值不了一條「只在升級當下跑一次、之後永遠沒人測」的遷移路徑。 */
const payloadSchema = z.object({
  v: z.literal(PAYLOAD_VERSION),
  state: stateSchema,
});

// ---------------------------------------------------------------------------
// 合法性
// ---------------------------------------------------------------------------

/**
 * 這份 state 可以被寫出去 / 讀回來嗎。
 *
 * 通過 schema 只代表**形狀**對,不代表這份對話**送得出去**。真正的判準是
 * transcript.ts 的那條鐵律,而它有一個合法的例外:還沒被處置的那張卡。
 *
 *   · 沒有待處理的卡 → 一個懸空的 tool_use 都不能有;
 *   · 有 pending / pendingAsk / pendingCode → 恰好一個懸空,而且必須就是那張卡的
 *     toolUseId。
 *
 * 第二條的「必須是那一個」不是潔癖:pending 指著一個**已經有結果**的 tool_use 時,
 * 按下確認會補出第二則同 id 的 tool_result;而 pending 指著一個**不存在**的
 * tool_use 時,那張卡按下去等於憑空生出一則結果。兩種都會讓下一次 /chat 被拒收。
 *
 * 沙盒卡(§4.7)算在同一個例外裡,而且它的還原**會自己跑完**:面板一掛載就把它
 * 執行掉、補上結果、續跑 /chat。這件事之所以可以接受,正是這個功能的前提本身 ——
 * 那段程式碼沒有副作用,重跑一次與跑第一次是同一件事。對照組是「不存 pendingCode」:
 * 那樣還原出來的 transcript 帶著懸空的 tool_use,整份對話只能整包丟掉。
 *
 * 另外兩條與渲染有關:entry id 是 React key(重複 → 畫面錯亂),而 seq 是下一個 id
 * 的序號(倒退 → 新條目與舊條目撞號)。這兩件事 schema 驗不出來,因為它們是**條目
 * 之間**的關係。
 */
export function isRestorableState(state: TranscriptState): boolean {
  // transcript.ts:loop 一輪最多攔下一個 tool_use,三張卡不可能同時待處理。
  const cards = [state.pending, state.pendingAsk, state.pendingCode].filter(
    (card) => card !== null,
  );
  if (cards.length > 1) return false;

  const ids = new Set(state.entries.map((entry) => entry.id));
  if (ids.size !== state.entries.length) return false;
  if (state.seq < state.entries.length) return false;

  const dangling = findDanglingToolUseIds(state.messages);
  const allowed =
    state.pending?.toolUseId ??
    state.pendingAsk?.toolUseId ??
    state.pendingCode?.toolUseId ??
    null;
  if (allowed === null) return dangling.length === 0;
  return dangling.length === 1 && dangling[0] === allowed;
}

// ---------------------------------------------------------------------------
// 容量:超過上限就從**最舊的一輪**開始砍
// ---------------------------------------------------------------------------

/**
 * 這一則是「使用者自己送出的那一句」嗎。
 *
 * 判準是「role 為 user 且帶 text block」。loop 產生的 user 訊息只裝 tool_result
 * (agent-loop.ts 的 resultMessage),而 appendUserMessage 產生的恰好是一個 text
 * block —— 兩者在形狀上就分得開,不必另外記旗標。
 */
function isUserSend(message: AiChatMessage): boolean {
  return message.role === "user" && message.content.some((b) => b.type === "text");
}

function indexOfNth<T>(items: readonly T[], match: (item: T) => boolean, nth: number): number {
  let seen = 0;
  for (const [index, item] of items.entries()) {
    if (!match(item)) continue;
    seen += 1;
    if (seen === nth) return index;
  }
  return -1;
}

/**
 * 砍掉最舊的一輪:把開頭一路丟到**第二次**使用者送出為止。丟不動(整份只有一輪)
 * 回 null。
 *
 * ── 為什麼「使用者送出的那一則」是安全的切點 ────────────────────────────────
 * 送出這個動作被 canSend 守著(AgentPanel.onSend),而 canSend 為真的前提是
 * findDanglingToolUseIds(messages) 為空。所以在第 k 次送出的那一刻,它**前面**的
 * 每一個 tool_use 都已經有結果了 —— 被丟掉的那一段是自我封閉的,不會有一個
 * tool_use 留在被丟掉的前段、而它的 tool_result 落在保留的後段(反之亦然)。
 * 換句話說:從任何一次使用者送出切開,兩邊都各自合法。
 *
 * entries 跟著砍到**第 n 個 user 條目**是對得上的:appendUserMessage 一次同時
 * 產生一則 user 訊息與一個 user 條目,兩串的第 k 個 user 一定是同一次送出。
 *
 * ── 為什麼選「砍」而不是「超過就整包不存」 ─────────────────────────────────
 * 任務書兩條路都允許。選砍的理由是後者的失敗模式很惡劣:一份長對話一旦跨過上限,
 * 使用者不會收到任何訊號,只會發現「這次重整就沒了」—— 而且他愈用愈可能踩到。
 * 砍則是漸進的:舊的那幾輪不見了,手上這一輪還在。而上面那段證明讓「砍」不必付
 * 破壞鐵律的風險 —— 切點的安全性是 canSend 給的,不是靠掃描猜出來的。
 *
 * 砍到只剩一輪還是超標(單筆巨大的工具結果)時仍然回 null,由 serialize 決定不存。
 * 那時「不存」才是唯一剩下的安全選項。
 */
function dropOldestTurn(state: TranscriptState): TranscriptState | null {
  const messageCut = indexOfNth(state.messages, isUserSend, 2);
  const entryCut = indexOfNth(state.entries, (entry) => entry.kind === "user", 2);
  if (messageCut < 0 || entryCut < 0) return null;
  return {
    ...state,
    messages: state.messages.slice(messageCut),
    entries: state.entries.slice(entryCut),
  };
}

// ---------------------------------------------------------------------------
// 對外的兩個純函式
// ---------------------------------------------------------------------------

/**
 * state → 要寫進 localStorage 的字串。**寫不得就回 null**(呼叫端的處置是刪掉那個
 * key,不是留著上一份)。
 *
 * 三種回 null 的情形:state 本身就不合法(那是 bug,但不該把 bug 存起來留到下次)、
 * 砍到不能再砍還是超標、序列化本身失敗。
 */
export function serializeTranscript(state: TranscriptState): string | null {
  if (!isRestorableState(state)) return null;
  let candidate: TranscriptState = state;
  for (;;) {
    let raw: string;
    try {
      raw = JSON.stringify({ v: PAYLOAD_VERSION, state: candidate });
    } catch {
      // 迴圈參照 / BigInt。理論上不會有(這些值都是從 JSON 來的),但序列化失敗
      // 若讓它 throw 就會炸在一個 effect 裡。
      return null;
    }
    if (raw.length <= AGENT_TRANSCRIPT_MAX_CHARS) return raw;
    const trimmed = dropOldestTurn(candidate);
    if (trimmed === null) return null;
    candidate = trimmed;
  }
}

/** localStorage 的字串 → state。壞掉、版本不符、形狀不對、或還原出來不合法 → null。 */
export function deserializeTranscript(raw: string): TranscriptState | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) return null;
  const state = parsed.data.state;
  return isRestorableState(state) ? state : null;
}

// ---------------------------------------------------------------------------
// localStorage(這一段以下才碰瀏覽器)
// ---------------------------------------------------------------------------

export function readStoredTranscript(key: string): TranscriptState | null {
  return withStorage<TranscriptState | null>(null, (storage) => {
    const raw = storage.getItem(key);
    return raw === null ? null : deserializeTranscript(raw);
  });
}

/**
 * 寫入。空對話與「寫不得」都走刪除,不留舊的那一份 —— 留著的話下一次重整會把一段
 * 更舊的對話端回來,而使用者剛剛看到的明明是別的東西。
 */
export function writeStoredTranscript(key: string, state: TranscriptState): void {
  const raw = state.entries.length === 0 ? null : serializeTranscript(state);
  withStorage(undefined, (storage) => {
    if (raw === null) {
      storage.removeItem(key);
      return;
    }
    try {
      storage.setItem(key, raw);
    } catch {
      // 配額爆掉(別的功能把 origin 塞滿了)。留著半份沒意義,刪掉。
      storage.removeItem(key);
    }
  });
}

// clearStoredTranscript / clearAllStoredTranscripts 在 ./persist-keys,並由本檔頂端
// 原樣再導出 —— 刪一筆資料不需要認識那筆資料的形狀,而那正是把它們切出去的理由。
