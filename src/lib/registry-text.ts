// 付費插件協定:registry 寫的文字 —— offer.note、402 的 message(之後還有上新通知的
// title / body)—— 一律先經過這裡才顯示或印出。惡意或寫壞的 registry 頂多在自己的條目上
// 寫錯字:不能在 CLI 裡送終端控制碼(清畫面、改視窗標題、蓋掉前一行輸出),也不能用雙向
// 文字控制字元把畫面上的字排成另一個意思。
//
// cli/src/registry-text.ts 是同一份實作(CLI 不 import core,見 cli/src/registry.ts 檔頭)。
// test/registry-text.test.ts 拿同一組輸入比對兩邊的輸出 —— 改一邊就得改另一邊。

/** 402 的 message 顯示上限(字元數,以 code point 計)。 */
export const REGISTRY_MESSAGE_MAX = 200;

// ECMA-48 的控制序列,順序有意義:
//   1. CSI:ESC [ 或 8-bit 0x9B,參數 0x30–0x3F、中間字元 0x20–0x2F、結尾 0x40–0x7E
//   2. 字串型:OSC / DCS / SOS / PM / APC(ESC ] P X ^ _ 或 8-bit 0x9D 0x90 0x98 0x9E 0x9F),
//      到 BEL、ST(ESC \ 或 0x9C)為止;沒有結尾就吃到字串尾(終端機也會這樣吞掉)
//   3. 其他 ESC 序列:ESC + 中間字元 + 一個結尾字元(ESC 7、ESC c、ESC ( B …)
const CSI_RE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const STRING_SEQ_RE = /(?:\u001b[\]PX^_]|[\u0090\u0098\u009d\u009e\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g;
const ESC_SEQ_RE = /\u001b[ -/]*[0-~]/g;
// 剩下的 C0 / DEL / C1 控制字元(含落單的 ESC)。
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
// 雙向文字的嵌入、覆寫與隔離字元(Trojan Source 用的那一組)。
const BIDI_RE = /[\u202a-\u202e\u2066-\u2069]/g;

/**
 * 去掉 ANSI 序列與控制字元,空白類(換行、tab)換成一個空格,再截到 max 個字元。
 * 結果是單行純文字;原本就乾淨的字串原樣回傳(前後空白除外)。
 */
export function sanitizeRegistryText(raw: string, max?: number): string {
  const clean = raw
    .replace(CSI_RE, "")
    .replace(STRING_SEQ_RE, "")
    .replace(ESC_SEQ_RE, "")
    .replace(/[\t\n\v\f\r]+/g, " ")
    .replace(CONTROL_RE, "")
    .replace(BIDI_RE, "")
    .replace(/ {2,}/g, " ")
    .trim();
  if (max === undefined) return clean;
  const chars = Array.from(clean);
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : clean;
}

/** 字元數(code point):「≤ 40 字」的上限以這個算,中文與 emoji 都算一個字。 */
export function registryTextLength(text: string): number {
  return Array.from(text).length;
}
