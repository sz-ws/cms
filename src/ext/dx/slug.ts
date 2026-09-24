// 內容 slug 的唯一一份正規化規則。server(content-provider.ts 存檔時)與 client
// (fields/SlugField.tsx 的即時預覽)都 import 這支 —— 以前兩邊各寫一份
// `[^a-z0-9-]` 的版本,一旦只改到其中一邊,編輯者在表單上看到的網址就不是存下來的
// 那一個。本檔必須維持純函式、零 import,client bundle 才拉得進來。
//
// 舊規則只留 a-z0-9,中文、日文、韓文標題因此一律得到**空** slug —— 詳細頁沒有網址,
// 或同型別的第二篇起全部擠成 `<type>-2`、`<type>-3`。新規則保留任何語言的字母與數字,
// 但對純 ASCII 輸入的結果與舊規則**逐字相同**:update 每次存檔都會從標題重算 slug
// (見 content-provider.ts deriveSlug),ASCII 結果若有任何一點不同,既有文章下次一存
// 網址就變了,外部連結跟著失效。
//
// 規則(依序):
//   1. 刪除 Default_Ignorable(零寬連字、變體選擇符 FE0F、軟連字號…)與 enclosing mark
//      (keycap 的 20E3)—— 這些只是 emoji 或排版的黏著劑,留下來會變成網址裡看不見的字。
//   2. **非 ASCII** 的標點、符號、空白、emoji → 分隔。中日文不用空格斷詞,「、」「・」
//      「!」就是詞與詞的界線。這一步必須在 NFKC **之前**:全形「!:」經 NFKC 會變成
//      ASCII 的 `!:`,那就落進第 5 步被刪掉,兩個詞黏成一個。
//   3. NFKC:全形英數 → 半形、半形片假名 → 全形、合字拆開,同一個字只有一種寫法。
//   4. 小寫。
//   5. 空白 → `-`,其餘不是字母 / 數字 / 組合記號(\p{M},韓文與印度系文字靠它)的字元
//      一律刪除 —— 這就是舊規則(`don't` → `dont`、`v1.2` → `v12`)的 Unicode 版。
//   6. 連續 `-` 收成一個、頭尾的 `-` 去掉,最長 SLUG_MAX_LENGTH 個 code point。

/** slug 最長幾個 code point(不是 UTF-16 長度 —— 以 length 截會切斷 surrogate pair)。 */
export const SLUG_MAX_LENGTH = 80;

const IGNORABLE_RE = /[\p{Default_Ignorable_Code_Point}\p{Me}]/gu;
const NON_ASCII_SEPARATOR_RE = /[^\p{L}\p{N}\p{M}\p{ASCII}]+/gu;
const WHITESPACE_RE = /\s+/g;
const DISALLOWED_RE = /[^\p{L}\p{N}\p{M}-]/gu;
const DASH_RUN_RE = /-+/g;

/** 取前 max 個 code point。for…of 以 code point 走訪,不會切出孤立的 surrogate。 */
function takeCodePoints(input: string, max: number): string {
  let out = "";
  let count = 0;
  for (const ch of input) {
    if (count === max) break;
    out += ch;
    count++;
  }
  return out;
}

function normalizeSlug(input: string, keepTrailingDash: boolean): string {
  const joined = input
    .replace(IGNORABLE_RE, "")
    .replace(NON_ASCII_SEPARATOR_RE, " ")
    .normalize("NFKC")
    .toLowerCase()
    .replace(WHITESPACE_RE, "-")
    .replace(DISALLOWED_RE, "")
    .replace(DASH_RUN_RE, "-")
    .replace(/^-/, "");
  const capped = takeCodePoints(joined, SLUG_MAX_LENGTH);
  return keepTrailingDash ? capped : capped.replace(/-$/, "");
}

/**
 * 標題 / 手打的字串 → slug。"春季新品 2026!" → "春季新品-2026",
 * "Hello World" → "hello-world"。沒有任何可用字元(空字串、純標點、純 emoji)→ ""。
 */
export function slugify(input: string): string {
  return normalizeSlug(input, false);
}

/**
 * 輸入框逐字正規化用:與 slugify 同一套規則,但保留**結尾**的一個 `-`。
 * 每按一鍵就 slugify 的話,「hello」後面那個空白或 `-` 會立刻被頭尾修剪吃掉,
 * 使用者永遠打不出第二個詞。離開輸入框時再以 slugify 收尾;
 * slugify(slugifyDraft(x)) === slugify(x)。
 */
export function slugifyDraft(input: string): string {
  return normalizeSlug(input, true);
}
