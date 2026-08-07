// docs/spec-admin-agent.md §5:確認卡的「參數表」。
//
// 這一段是整個確認制實際被人讀到的地方。admin 按下〔確認執行〕之前唯一能核對的
// 就是這張表,所以它的規則有兩條:
//
// 1. **看得到的就是會送出去的。**不美化、不改寫鍵名、不換算單位 —— 表上的
//    `id: abc` 就是 /execute 收到的 `id: "abc"`。
// 2. **不會因為資料很大就變成一團 JSON。**巢狀物件縮排展開到一定深度;再深、
//    或列數過多,就退成截斷過的 JSON 並明白標注,而不是靜默截掉尾巴。
//
// 抽成純函式是為了能測:一個「深層物件被摺疊成 JSON」的行為,用渲染測比用資料
// 測貴十倍,而錯的代價是 admin 核對了一份不完整的參數。

/** 參數表的一列。value === null 代表這是一個容器(物件/陣列)的標題列。 */
export interface ArgRow {
  /** 顯示用的鍵(陣列元素是 `[0]`)。 */
  key: string;
  /** 縮排層級,0 起。 */
  depth: number;
  /** 純量的字面值;容器標題列為 null。 */
  value: string | null;
  /** 容器標題列的摘要(如 `3 項`);純量列為 undefined。 */
  hint?: string;
}

/** 展開深度上限。再深就整段以 JSON 顯示 —— 縮排到第四層已經不比 JSON 好讀。 */
export const ARG_MAX_DEPTH = 3;
/** 列數上限。超過就停下並補一列標注,不靜默截斷。 */
export const ARG_MAX_ROWS = 60;
/** 單一值的字元上限。 */
export const ARG_VALUE_MAX_CHARS = 400;

function truncate(raw: string): string {
  return raw.length > ARG_VALUE_MAX_CHARS
    ? `${raw.slice(0, ARG_VALUE_MAX_CHARS)}…`
    : raw;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "[unserializable]";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 純量的顯示字串。字串原樣(不加引號 —— 表格的欄位分隔已經表達了邊界)。 */
function scalarText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === undefined) return "—";
  return truncate(jsonText(value));
}

function isScalar(value: unknown): boolean {
  return value === null || value === undefined || typeof value !== "object";
}

/**
 * args → 參數表。
 *
 * 非物件的 args(理論上不該發生,但 LLM 送得出來)不特別處理:包成單列 `value`,
 * 讓 admin 看見真正被送出的東西,而不是一張空表。
 */
export function flattenArgs(args: unknown): ArgRow[] {
  const rows: ArgRow[] = [];
  if (args === undefined || args === null) return rows;
  if (!isPlainObject(args)) {
    rows.push({ key: "value", depth: 0, value: scalarText(args) });
    return rows;
  }
  walk(args, 0, rows);
  return rows;
}

function pushOverflow(rows: ArgRow[], depth: number): void {
  rows.push({ key: "…", depth, value: null, hint: "truncated" });
}

function walk(node: Record<string, unknown>, depth: number, rows: ArgRow[]): void {
  for (const [key, value] of Object.entries(node)) {
    if (rows.length >= ARG_MAX_ROWS) {
      pushOverflow(rows, depth);
      return;
    }
    emit(key, value, depth, rows);
  }
}

function emit(key: string, value: unknown, depth: number, rows: ArgRow[]): void {
  if (isScalar(value)) {
    rows.push({ key, depth, value: scalarText(value) });
    return;
  }
  // 深到底:整段以 JSON 呈現。標注是必要的 —— 沒有它,一段 JSON 看起來就只是
  // 「一個很長的字串值」,admin 分不出這裡本來還有結構。
  if (depth >= ARG_MAX_DEPTH) {
    rows.push({ key, depth, value: truncate(jsonText(value)), hint: "json" });
    return;
  }
  if (Array.isArray(value)) {
    // 全是純量的陣列排成一行(`tags: a, b, c`)—— 展開只會多三列而不多任何資訊。
    if (value.every(isScalar)) {
      rows.push({ key, depth, value: value.map(scalarText).join(", ") || "[]" });
      return;
    }
    rows.push({ key, depth, value: null, hint: `${value.length}` });
    value.forEach((item, index) => {
      if (rows.length >= ARG_MAX_ROWS) return;
      emit(`[${index}]`, item, depth + 1, rows);
    });
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  rows.push({ key, depth, value: null, hint: `${entries.length}` });
  walk(value as Record<string, unknown>, depth + 1, rows);
}
