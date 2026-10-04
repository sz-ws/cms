import { z } from "zod";

// 1.70.0:確認卡上的「會改動什麼」。
//
// 確認卡原本只有一句摘要與攤平的參數。對「改內文的第幾段」這種動作,參數(match、index、
// 一團節點)說不出 admin 真正要判斷的事:東西會加在哪裡、哪一段會不見。preview 讓 write
// tool 把這件事算好交給卡片:改動的地方照原本的順序排出來,前後各留一點沒變的內容當位置。
//
// 跟 display 同一套紀律:**由 tool 從站上的資料算出來,不是模型寫的**(卡片上的字都必須是
// server 推導的事實),形狀是封閉的一小組、有硬上限,驗不過就整份不畫,卡片退回參數表。
// tool 不帶畫面 —— 它只說「哪幾行、各是加入/移除/沒變」,怎麼畫是面板的事,所以換後台風格
// 或加一種 tool 都不必動對方。

export const AGENT_PREVIEW_MAX_LINES = 60;
export const AGENT_PREVIEW_MAX_TEXT = 400;

/** 一行:一段內容(沒變 / 加入 / 移除),或「中間 N 段沒變」。 */
export type AgentPreviewLine =
  | {
      change: "kept" | "added" | "removed";
      /** 這一段的字。圖片的話是它的替代文字(可以是空的)。 */
      text: string;
      /** 這一段是圖片:站內檔案的路徑(/api/files/<key>)。 */
      image?: string;
      /** 這一段是標題。 */
      heading?: boolean;
    }
  | { change: "gap"; count: number };

export interface AgentPreview {
  kind: "changes";
  lines: AgentPreviewLine[];
}

/** 只收站內檔案:預覽是 server 算的,但路徑來自內容,照 renderer 的規則再擋一次。 */
const imagePath = z
  .string()
  .max(300)
  .regex(/^\/api\/files\/[^\s"'<>]+$/)
  .refine((src) => !src.includes(".."));

const lineSchema = z.union([
  z
    .object({
      change: z.enum(["kept", "added", "removed"]),
      text: z.string().max(AGENT_PREVIEW_MAX_TEXT),
      image: imagePath.optional(),
      heading: z.boolean().optional(),
    })
    .strict(),
  z.object({ change: z.literal("gap"), count: z.number().int().min(1).max(100_000) }).strict(),
]);

export const agentPreviewSchema: z.ZodType<AgentPreview> = z
  .object({
    kind: z.literal("changes"),
    lines: z.array(lineSchema).min(1).max(AGENT_PREVIEW_MAX_LINES),
  })
  .strict();
