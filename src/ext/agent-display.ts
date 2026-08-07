import { z } from "zod";
import {
  PROPORTION_PRESETS,
  TREND_PRESETS,
  type ProportionWidgetData,
  type TrendWidgetData,
} from "@/components/admin/dashboard/widgets/types";

// docs/spec-admin-agent.md §5.1:agent tool 結果的卡片式呈現。
//
// ── 為什麼呈現由 tool 宣告,不由模型宣告 ────────────────────────────────────
// 直覺的做法是給模型一個「畫個圖」的 tool,讓它把要畫的數字當參數送進來。那條路
// 在這個系統裡是**不能走的**:模型送進來的參數是它自己寫的字,而圖表最強的一件事
// 就是讓數字看起來像事實。一張畫著「42 篇文章」的長條圖,不會因為那 42 是幻覺而
// 長得比較可疑 —— 它看起來跟真的一模一樣。
//
// 所以呈現的宣告權在 tool 手上:是**它自己剛跑完的 run() 結果**被轉成 widget spec,
// 模型從頭到尾沒有機會插手那些數字。模型能決定的只有「要不要呼叫這個 tool」,
// 而那本來就是它的職權。
//
// ── 為什麼復用 dashboard widget 家族,而不是新做一套圖表元件 ────────────────
// src/components/admin/dashboard/widgets 早就寫著「preset 元件不知道資料從哪來」
// (見該目錄 index.tsx 檔頭),兩個資料契約 × 八款畫法,house-style 已經定型。
// 這裡只是第三個呼叫端(前兩個是 dashboard 本身與 declarative dashboardCards)。
// 另開一套圖表元件的代價不是多寫幾個檔,是後台從此有兩種長相不同的長條圖。
//
// ── 這一層只有形狀,沒有元件 ────────────────────────────────────────────────
// 本檔屬於 src/ext(worker 端的 CORE_API 表面),**絕不能 import React**。widgets/
// types.ts 是純型別 + const 陣列,正是為了讓它能同時被 worker 與瀏覽器端引用;
// 真正的渲染在 src/components/admin/agent/DisplayCard.tsx。

/** segments 上限。超過這個數目的佔比圖已經讀不出比例,而且 payload 會撐 transcript。 */
export const AGENT_DISPLAY_MAX_SEGMENTS = 12;
/** series 上限。14 天 / 30 天 / 52 週都在內,再長的序列該換一個 tool。 */
export const AGENT_DISPLAY_MAX_SERIES = 60;
/** 任一字串欄位(label / valueLabel / caption)的上限。 */
export const AGENT_DISPLAY_MAX_TEXT = 120;

/**
 * 一份 tool 結果的呈現宣告。兩個 kind 對應 widgets 的兩個資料契約 ——
 * 換 preset 不必換資料形狀,所以 tool 作者挑的是「哪種鏡頭 + 哪種畫法」。
 */
export type AgentDisplay =
  | {
      kind: "proportion";
      preset: (typeof PROPORTION_PRESETS)[number];
      data: ProportionWidgetData;
    }
  | {
      kind: "trend";
      preset: (typeof TREND_PRESETS)[number];
      data: TrendWidgetData;
    };

const text = z.string().min(1).max(AGENT_DISPLAY_MAX_TEXT);
const optionalText = z.string().max(AGENT_DISPLAY_MAX_TEXT).optional();

// z.number() 在 zod 4 已經擋掉 NaN / ±Infinity,不必再 refine —— 而那正是這裡最
// 需要擋的兩個值:它們會讓 SVG 的 width/height 算出 "NaN%",畫面直接空白。
const proportionDataSchema = z
  .object({
    label: text,
    segments: z
      .array(z.object({ id: text, label: text, value: z.number() }))
      .min(1)
      .max(AGENT_DISPLAY_MAX_SEGMENTS),
    total: z.number().optional(),
    valueLabel: optionalText,
  })
  .strict();

const trendDataSchema = z
  .object({
    label: text,
    value: z.union([z.number(), z.string().max(AGENT_DISPLAY_MAX_TEXT)]),
    delta: z
      .object({
        value: z.number(),
        direction: z.enum(["up", "down", "flat"]),
        caption: optionalText,
      })
      .strict()
      .optional(),
    series: z.array(z.number()).max(AGENT_DISPLAY_MAX_SERIES).optional(),
  })
  .strict();

/**
 * display 的守門。**上限不是禮貌,是防線**:display 的產物會原樣進 outcome、
 * 再原樣進前端的 transcript,一個壞掉的 extension(或一個含一萬段的資料集)
 * 能就這樣把整包 payload 灌爆。所以段數、序列長度、字串長度各有硬上限,超限
 * 的一律不是「截斷後照畫」,而是整張卡不畫 —— 半殘的圖表比沒有圖表更誤導。
 *
 * `.strict()` 同理:多出來的鍵代表送的人以為自己在宣告某種我們不認得的東西,
 * 而我們會安靜地把它丟掉。寧可整張卡不畫,讓作者當場發現。
 *
 * 型別註記(z.ZodType<AgentDisplay>)是刻意的:AgentDisplay 與這份 schema 是兩份
 * 宣告,一份給作者看、一份給守門用。沒有這個註記,兩者會各自漂移到某天 safeParse
 * 通過卻渲染不出來。
 */
export const agentDisplaySchema: z.ZodType<AgentDisplay> = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("proportion"),
        preset: z.enum(PROPORTION_PRESETS),
        data: proportionDataSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("trend"),
        preset: z.enum(TREND_PRESETS),
        data: trendDataSchema,
      })
      .strict(),
  ],
);
