// OG 圖的字型子集邏輯。
//
// 刻意獨立成一個檔案而不是留在 route 裡:route 會 import `workers-og`,而它以
// `import x from "./x.wasm"` 載入 yoga / resvg —— vitest 解析不了 .wasm,
// 於是整個 route 模組在測試裡載不起來。抽出來之後這幾個純函式測得到。

export const OG_FONT_FAMILY = "Chiron GoRound TC";
export const OG_FONT_WEIGHTS = [400, 700] as const;

/**
 * 把 props 裡所有字串攤平成一個字串,交給 Google Fonts 做子集抓取。
 *
 * 為什麼要這樣做:完整的繁中字型有好幾 MB,不可能塞進 Worker;`loadGoogleFont`
 * 的 `text` 參數讓它只回傳**實際用到的字元**的子集(實測一行標題約 6.7KB / 53ms)。
 * 漏掉任何一段會被渲染的文字,那幾個字就會變成豆腐塊,所以這裡刻意遞迴收集
 * 而不是列舉已知欄位 —— 模板有 16 個,各自的 props 形狀不同。
 */
export function collectText(value: unknown, depth = 0): string {
  if (depth > 6) return ""; // 防遞迴爆炸;OG props 不會有這麼深
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((v) => collectText(v, depth + 1)).join(" ");
  if (value && typeof value === "object") {
    return Object.values(value)
      .map((v) => collectText(v, depth + 1))
      .join(" ");
  }
  return "";
}
