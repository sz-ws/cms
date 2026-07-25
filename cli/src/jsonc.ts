// JSONC 讀寫 —— 保留註解與排版的外科式編輯。
//
// wrangler.jsonc 幾乎每個欄位上面都壓著一段中文註解(為什麼 main 指向 custom-worker.ts、
// 為什麼有第二個 database_id 佔位值……),那些註解就是這份設定檔的文件本體。
// `JSON.parse` → 改 → `JSON.stringify` 會把它們全部吃掉,排版也重排,所以**不能**那樣做。
//
// 這裡的做法:寫一個會記錄字元位移(span)的 JSONC parser。要改某個值時,只替換
// 「那個值的字面量」所佔的字元區間,檔案其餘 byte 一個都不動 —— 註解、縮排、
// 尾逗號、鍵的順序、甚至 CRLF 全部原樣保留。
//
// 附帶好處:同一個 parser 也是「讀出目前設定了什麼」的工具,所以偵測與寫入共用一套解析,
// 不會出現「讀的時候看到 A、寫的時候找到 B」的錯位。

export interface Span {
  /** 起始位移(含)。 */
  start: number;
  /** 結束位移(不含)。 */
  end: number;
}

export interface JsoncMember {
  key: string;
  keySpan: Span;
  value: JsoncNode;
}

export type JsoncNode =
  | { kind: "object"; span: Span; members: JsoncMember[] }
  | { kind: "array"; span: Span; items: JsoncNode[] }
  | { kind: "string"; span: Span; value: string }
  | { kind: "number"; span: Span; value: number }
  | { kind: "boolean"; span: Span; value: boolean }
  | { kind: "null"; span: Span };

export class JsoncParseError extends Error {
  offset: number;
  constructor(message: string, offset: number) {
    super(`${message}(位移 ${offset})`);
    this.name = "JsoncParseError";
    this.offset = offset;
  }
}

/** 跳過空白與註解(`//` 行註解、`/* *\/` 區塊註解)。 */
function skipTrivia(text: string, i: number): number {
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) throw new JsoncParseError("區塊註解沒有結尾", i);
      i = close + 2;
      continue;
    }
    return i;
  }
}

interface Parsed {
  node: JsoncNode;
  next: number;
}

function parseString(text: string, start: number): { value: string; next: number } {
  let i = start + 1; // 跳過開頭的 "
  let out = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const esc = text[i + 1];
      switch (esc) {
        case '"':
        case "\\":
        case "/":
          out += esc;
          i += 2;
          break;
        case "b":
          out += "\b";
          i += 2;
          break;
        case "f":
          out += "\f";
          i += 2;
          break;
        case "n":
          out += "\n";
          i += 2;
          break;
        case "r":
          out += "\r";
          i += 2;
          break;
        case "t":
          out += "\t";
          i += 2;
          break;
        case "u": {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new JsoncParseError("無效的 \\u escape", i);
          }
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 6;
          break;
        }
        default:
          throw new JsoncParseError(`無效的 escape:\\${esc ?? ""}`, i);
      }
      continue;
    }
    if (ch === '"') return { value: out, next: i + 1 };
    out += ch;
    i++;
  }
  throw new JsoncParseError("字串沒有結尾", start);
}

function parseValue(text: string, i0: number): Parsed {
  const start = skipTrivia(text, i0);
  const ch = text[start];
  if (ch === undefined) throw new JsoncParseError("內容提前結束", start);

  if (ch === '"') {
    const { value, next } = parseString(text, start);
    return { node: { kind: "string", span: { start, end: next }, value }, next };
  }

  if (ch === "{") {
    const members: JsoncMember[] = [];
    let i = skipTrivia(text, start + 1);
    if (text[i] === "}") {
      return { node: { kind: "object", span: { start, end: i + 1 }, members }, next: i + 1 };
    }
    for (;;) {
      i = skipTrivia(text, i);
      if (text[i] === "}") break; // 容忍尾逗號
      if (text[i] !== '"') throw new JsoncParseError("物件的鍵必須是字串", i);
      const keyStart = i;
      const { value: key, next: afterKey } = parseString(text, i);
      i = skipTrivia(text, afterKey);
      if (text[i] !== ":") throw new JsoncParseError("鍵之後缺少 :", i);
      const parsedValue = parseValue(text, i + 1);
      members.push({
        key,
        keySpan: { start: keyStart, end: afterKey },
        value: parsedValue.node,
      });
      i = skipTrivia(text, parsedValue.next);
      if (text[i] === ",") {
        i++;
        continue;
      }
      break;
    }
    i = skipTrivia(text, i);
    if (text[i] !== "}") throw new JsoncParseError("物件沒有結尾 }", i);
    return { node: { kind: "object", span: { start, end: i + 1 }, members }, next: i + 1 };
  }

  if (ch === "[") {
    const items: JsoncNode[] = [];
    let i = skipTrivia(text, start + 1);
    if (text[i] === "]") {
      return { node: { kind: "array", span: { start, end: i + 1 }, items }, next: i + 1 };
    }
    for (;;) {
      i = skipTrivia(text, i);
      if (text[i] === "]") break; // 容忍尾逗號
      const parsedItem = parseValue(text, i);
      items.push(parsedItem.node);
      i = skipTrivia(text, parsedItem.next);
      if (text[i] === ",") {
        i++;
        continue;
      }
      break;
    }
    i = skipTrivia(text, i);
    if (text[i] !== "]") throw new JsoncParseError("陣列沒有結尾 ]", i);
    return { node: { kind: "array", span: { start, end: i + 1 }, items }, next: i + 1 };
  }

  if (text.startsWith("true", start)) {
    return {
      node: { kind: "boolean", span: { start, end: start + 4 }, value: true },
      next: start + 4,
    };
  }
  if (text.startsWith("false", start)) {
    return {
      node: { kind: "boolean", span: { start, end: start + 5 }, value: false },
      next: start + 5,
    };
  }
  if (text.startsWith("null", start)) {
    return { node: { kind: "null", span: { start, end: start + 4 } }, next: start + 4 };
  }

  const numMatch = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(start));
  if (numMatch) {
    const end = start + numMatch[0].length;
    return {
      node: { kind: "number", span: { start, end }, value: Number(numMatch[0]) },
      next: end,
    };
  }

  throw new JsoncParseError(`無法解析的字元「${ch}」`, start);
}

/** 解析 JSONC(允許註解與尾逗號),回傳帶字元位移的節點樹。 */
export function parseJsonc(text: string): JsoncNode {
  const { node, next } = parseValue(text, 0);
  const rest = skipTrivia(text, next);
  if (rest < text.length) {
    throw new JsoncParseError("根節點之後還有多餘內容", rest);
  }
  return node;
}

/** 取物件成員;非物件或找不到回 undefined。 */
export function getMember(node: JsoncNode, key: string): JsoncMember | undefined {
  if (node.kind !== "object") return undefined;
  return node.members.find((m) => m.key === key);
}

/** 取物件成員的字串值;型別不符回 undefined。 */
export function getStringMember(node: JsoncNode, key: string): string | undefined {
  const m = getMember(node, key);
  return m && m.value.kind === "string" ? m.value.value : undefined;
}

export interface JsoncEdit {
  /** 要被替換掉的字元區間(通常是某個值的字面量)。 */
  span: Span;
  /** 替換成的原始文字(呼叫端負責 JSON 轉義,見 quoteJsonString)。 */
  replacement: string;
}

/** 把字串轉成合法的 JSON 字面量(含引號)。 */
export function quoteJsonString(value: string): string {
  return JSON.stringify(value);
}

/**
 * 套用一組編輯。**由後往前**套用,前面的位移才不會被前一次替換弄歪。
 * 區間重疊會直接 throw —— 那代表呼叫端算錯了,靜默接受只會產生壞掉的檔案。
 */
export function applyEdits(text: string, edits: readonly JsoncEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.span.start - a.span.start);
  let out = text;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    if (edit.span.end > previousStart) {
      throw new Error("編輯區間重疊,拒絕寫入");
    }
    out = out.slice(0, edit.span.start) + edit.replacement + out.slice(edit.span.end);
    previousStart = edit.span.start;
  }
  return out;
}
