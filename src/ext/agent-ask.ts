import { z } from "zod";

// docs/spec-admin-agent.md §4.6:反問卡(elicitation)的參數形狀與給 LLM 的說明。
//
// 與 agent-loop.ts 同層、刻意分檔:loop 那一檔的主題是「LLM 說了什麼 → 站上發生
// 什麼」的控制流,而這裡是一份資料契約 —— 前端的卡片、模型看到的 JSON Schema、
// server 端的驗證三者都讀它。放在一起只會讓那條控制流更難一眼讀完。
//
// tool 名(CORE_UI_ASK)住 agent-loop.ts:那是**攔截規則**的一部分(loop 依名字
// 決定要不要停下來),不是這份契約的一部分。

/**
 * 給 LLM 的說明。比一般 tool 長,因為這個 tool 的難處不在參數而在時機:該問的
 * 時候用猜的,與查得到卻回頭問人,兩種都會讓面板變難用。
 */
export const ASK_DESCRIPTION = [
  "Ask the administrator ONE focused question when a detail you cannot look up is missing and guessing would be wrong.",
  "It renders as a card with buttons (or a small form) in the admin panel, and their answer comes back to you as the result of this call.",
  "Prefer concrete choices: two to six options they can click beats an open question.",
  "Provide `options` (single choice) OR `fields` (a short form) — exactly one of the two, never both, never neither.",
  "Set `allowFreeText` when none of the options may fit and a written answer is acceptable.",
  "Do NOT use it for anything a read tool can answer, do NOT ask more than one question per turn, and do NOT use it to ask permission for a write — write tools already produce their own confirmation card.",
].join(" ");

const askOptionSchema = z
  .object({
    /** 回給模型的識別字(admin 看不到)。 */
    value: z.string().min(1).max(100),
    /** 按鈕上的字。 */
    label: z.string().min(1).max(200),
    /** 按鈕下的一行補充。 */
    hint: z.string().max(200).optional(),
  })
  .strict();

const askFieldSchema = z
  .object({
    /** 回答物件的鍵。識別字文法 —— 它會原樣進 tool_result 的 JSON。 */
    key: z
      .string()
      .max(60)
      .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
    label: z.string().min(1).max(200),
    type: z.enum(["text", "textarea"]).optional(),
    required: z.boolean().optional(),
    placeholder: z.string().max(200).optional(),
  })
  .strict();

/**
 * 擇一規則之前的形狀。**JSON Schema 從這一份產出**:zod 的 superRefine 表達不成
 * JSON Schema,而擇一那條規則在 ASK_DESCRIPTION 裡模型讀得到、在下面的 schema 裡
 * 送壞了擋得住 —— 兩邊都有,轉換本身就不必扛它。
 */
export const askArgsObjectSchema = z
  .object({
    question: z.string().min(1).max(500),
    options: z.array(askOptionSchema).min(2).max(6).optional(),
    fields: z.array(askFieldSchema).min(1).max(6).optional(),
    /** 僅 options 模式有意義:附一個「其他」自由輸入。 */
    allowFreeText: z.boolean().optional(),
  })
  .strict();

/**
 * ask 的參數。options 與 fields **恰好擇一** —— 兩個都給的卡片畫不出來(要按鈕
 * 還是要表單?),兩個都不給的卡片沒有出口(admin 只能關掉它)。
 *
 * 驗不過的處置在 loop:錯誤摘要包成該 tool_use 的 tool_result 接回去續跑,不丟給
 * 前端(§4.5 的 harness 紀律 —— 模型看得到自己送壞了才會改)。
 */
export const askArgsSchema = askArgsObjectSchema.superRefine((args, ctx) => {
  if ((args.options !== undefined) === (args.fields !== undefined)) {
    ctx.addIssue({
      code: "custom",
      message: "provide exactly one of `options` or `fields`",
      path: [],
    });
  }
  // key 重複 = 後面那一欄的答案會蓋掉前面那一欄,而兩欄在畫面上都還在。與其讓
  // 模型收到一份少了一欄的答案,不如讓它重送。
  const seen = new Set<string>();
  for (const [index, field] of (args.fields ?? []).entries()) {
    if (seen.has(field.key)) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate field key "${field.key}"`,
        path: ["fields", index, "key"],
      });
    }
    seen.add(field.key);
  }
});

export type AgentAskOption = z.output<typeof askOptionSchema>;
export type AgentAskField = z.output<typeof askFieldSchema>;
/** 一張反問卡的內容(前端只 import type)。 */
export type AgentAsk = z.output<typeof askArgsSchema>;
