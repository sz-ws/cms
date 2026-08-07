import { z } from "zod";

// docs/spec-admin-agent.md §4.7:JS 沙盒(core.code.run)的參數形狀、給 LLM 的說明,
// 以及「沙盒吐出來的東西 → 回給模型的 tool_result」那一段收斂。
//
// 與 agent-ask.ts 同一個位置、同一個理由:agent-loop.ts 的主題是「LLM 說了什麼 →
// 站上發生什麼」的控制流,而這裡是一份**資料契約** —— 前端的卡片、模型看到的
// JSON Schema、執行端的驗證、localStorage 的還原,四邊都讀它。
//
// tool 名(CORE_CODE_RUN)住 agent-loop.ts:那是**攔截規則**的一部分。
//
// ── 為什麼這個 tool 存在 ────────────────────────────────────────────────────
// 模型被問到「這些訂單的中位數」「這兩個日期差幾天」時只能心算,而它會算錯 ——
// 而且錯得很有自信,admin 沒有任何線索知道那個數字是編的。給它一個真的能跑一小段
// JS 的地方,答案就從「生成」變成「計算」。
//
// ── 為什麼這一份不含任何執行程式碼 ──────────────────────────────────────────
// 執行那一層需要 Web Worker 與 WASM,兩者在測試用的 workerd 裡都不存在。把契約與
// 收斂(參數 schema、結果形狀、截斷規則)留在這個純函式檔裡,它們就能被直接測到;
// 真正碰瀏覽器 API 的只剩 components/admin/agent/code-sandbox.ts 那一層薄殼。

/**
 * 給 LLM 的說明。
 *
 * 最重要的是**中間那兩句**:沒有網路、拿不到站上的資料。少了它們,模型會寫出
 * `fetch('/api/admin/content')` 然後每一次都失敗 —— 而失敗的樣子是「沙盒壞了」,
 * 不是「你用錯了」,所以它會一直重試同一招。要算站上的東西,得先用 read tool 撈
 * 回來、把數字當字面量寫進程式碼裡。
 */
export const CODE_DESCRIPTION = [
  "Run a short piece of JavaScript in a sandbox and get the value back.",
  "Use it for arithmetic, dates, sorting and statistics — medians, totals, percentages, day differences, grouping. Compute here instead of working it out in your head; that is where numbers go wrong.",
  "The sandbox is a bare JavaScript interpreter. There is NO network (no fetch, no XMLHttpRequest, no WebSocket), no file system, no DOM, no storage, and NO access to this site's data.",
  "To compute over site data, first fetch it with a read tool, then write the numbers into the code as literals. Calling fetch('/api/...') does not work and never will.",
  "Available: the standard JavaScript built-ins (Math, Date, JSON, Array, String, Number, RegExp, …) and `console.log`. Nothing else.",
  "The value of the last expression comes back as `result` (JSON-serialised); anything you console.log comes back as `logs`.",
  "Every call starts from a clean interpreter — nothing you defined in an earlier call still exists, so include everything the snippet needs.",
  "Execution is aborted after a few seconds: no infinite loops, no huge allocations.",
  "Put a one-line `reason` in the administrator's language saying what you are computing; it is shown on the card next to the code.",
].join(" ");

/** 程式碼原文上限(字元)。 */
export const CODE_MAX_CHARS = 8_000;
/** `reason` 上限(字元)。卡片上的一行字,不是一段說明。 */
export const CODE_REASON_MAX_CHARS = 200;

/**
 * 執行逾時(毫秒)。
 *
 * 5 秒是「一段算術等得起、一個無窮迴圈等不下去」的分界:純運算的合理工作量
 * (排序幾千筆、算幾百個日期差)在 QuickJS 裡是毫秒級,跑超過 5 秒幾乎一定是
 * 迴圈條件寫錯。而 admin 是坐在畫面前等的 —— 這一輪對話已經停下來等這個結果了,
 * 逾時再長只是把「助理當掉了」的感覺拉長。
 *
 * 逾時**有兩道**:QuickJS 自己的 interrupt handler(讓它能回一個乾淨的錯誤),與
 * 外面那一層 worker.terminate()(interrupt handler 進不去的情況 —— 例如一個把記憶體
 * 吃光的單一運算 —— 唯一停得下來的辦法)。見 code-sandbox.ts。
 */
export const CODE_TIMEOUT_MS = 5_000;

/**
 * QuickJS runtime 的記憶體上限(位元組)。
 *
 * 不是安全邊界(安全邊界是「沒有 host binding」,見 code-sandbox.worker.ts),是
 * **可停性**邊界:`new Array(1e9).fill(0)` 這種單一運算不會經過 interrupt handler,
 * 記憶體上限讓它在 QuickJS 內就拋錯,而不是把整個分頁拖垮到連 terminate 都卡。
 */
export const CODE_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * QuickJS 的堆疊上限(位元組)。**這個數字是量出來的,不要憑感覺調大。**
 *
 * QuickJS 的堆疊檢查是拿「用掉多少」跟這個值比;設得比 WASM 實際的堆疊還大,檢查
 * 就永遠不會先觸發 —— 爆掉的是**宿主**。實測(Node 26 + quickjs-emscripten-core
 * 0.32,`function f(n){return f(n+1)} f(0)`):
 *
 *   ≤ 256 KB → QuickJS 自己攔下來,回一個乾淨的 `InternalError: stack overflow`
 *   ≥ 512 KB → 宿主丟 `RangeError: Maximum call stack size exceeded`,而且**後續的
 *              runtime.dispose() 會讓整個 WASM 模組 abort**(JS_FreeRuntime 的
 *              gc_obj_list 斷言)
 *
 * 所以取 256 KB。代價是遞迴深度上限約 1,360 層(同樣量出來的:64 KB→338、
 * 128 KB→679、256 KB→1,362),而這個 tool 的用途是算術與統計 —— 那些程式碼幾乎
 * 都是迴圈,一千多層遞迴綽綽有餘。「拿一個用不到的深度換一個會 abort 的失敗模式」
 * 是不划算的交換。
 */
export const CODE_STACK_LIMIT_BYTES = 256 * 1024;

/**
 * 序列化後的結果上限(字元)。
 *
 * 沿 agent-loop 的 TOOL_RESULT_MAX_CHARS 那組紀律,但更緊:一段程式碼很容易吐出
 * 一個一萬筆的陣列,而那份資料本來就是模型自己餵進去的 —— 它需要的是**算完的
 * 答案**,不是把輸入原樣拿回來。超過就截斷並標注(標注不是禮貌:模型看不到自己
 * 收到的是半份資料時,會把它當成完整事實)。
 */
export const CODE_RESULT_MAX_CHARS = 2_000;
/** logs 的行數上限。 */
export const CODE_LOG_MAX_LINES = 40;
/** logs 單行的字元上限。 */
export const CODE_LOG_LINE_MAX_CHARS = 400;

const codeArgsObjectSchema = z
  .object({
    /** 要跑的程式碼原文。**會原樣攤在卡片上給 admin 看**(見 CodeCard)。 */
    code: z.string().min(1).max(CODE_MAX_CHARS),
    /** 給人看的一句話(「算出中位數」)。模型省略時卡片只顯示程式碼。 */
    reason: z.string().max(CODE_REASON_MAX_CHARS).optional(),
  })
  .strict();

/**
 * core.code.run 的參數。
 *
 * 沒有 superRefine —— 這一份的規則簡單到 JSON Schema 表達得完,所以餵給 LLM 的
 * schema 與驗證用的是同一個物件(不像 agent-ask 要分成兩份)。
 */
export const codeArgsSchema = codeArgsObjectSchema;

/** 一張沙盒卡的內容(前端只 import type)。 */
export type AgentCode = z.output<typeof codeArgsSchema>;

// ---------------------------------------------------------------------------
// 沙盒 → 模型:結果的形狀與收斂
// ---------------------------------------------------------------------------

/**
 * worker 那一層原樣回報的東西(未截斷、未收斂)。
 *
 * `resultJson` 是**在沙盒裡序列化好的字串**而不是值本身:postMessage 走
 * structured clone,而 QuickJS 的值本來就要先攤成 host 值才過得去 —— 與其讓兩層
 * 各自決定「什麼東西攤不出來」,不如在最靠近 VM 的地方一次決定,外面只負責截斷。
 */
export interface AgentCodeRun {
  ok: boolean;
  /** 最後一個運算式的值,已 JSON 序列化。沒有值 / 序列化不出來時缺席。 */
  resultJson?: string;
  /** resultJson 缺席的原因(「回傳 undefined」「是一個 function」…)。 */
  resultNote?: string;
  logs: string[];
  /** ok:false 時的人話錯誤(guest 的例外訊息、逾時、載不起來…)。 */
  error?: string;
}

/**
 * 回給模型的形狀。這個物件會被 JSON 化成 tool_result 的內文。
 *
 * `result` 是**還原後的真值**而不是那串 JSON 文字:模型讀到的要是 `42` 與
 * `[1,2,3]`,不是 `"42"` 與 `"[1,2,3]"` —— 後者會讓它以為自己拿到的是字串,然後
 * 再寫一段程式碼去 parse 它。
 */
export interface AgentCodeOutput {
  ok: boolean;
  result?: unknown;
  /**
   * result 不是「完整的原值」時的說明。有這個鍵就代表要讀它:值不存在、序列化
   * 不出來、或太長被截成一段文字。
   */
  note?: string;
  logs?: string[];
  error?: string;
}

/** 一行 log 收進上限內,超過就截斷並留下 `…`。 */
function boundLine(line: string): string {
  return line.length > CODE_LOG_LINE_MAX_CHARS
    ? `${line.slice(0, CODE_LOG_LINE_MAX_CHARS)}…`
    : line;
}

/**
 * logs 收進上限內。行數超標時**留前面、丟後面**並補一行說明:一段程式碼的前幾行
 * log 通常是在交代它算了什麼,而最後幾行往往是同一個迴圈的重複。
 */
function boundLogs(logs: readonly string[]): string[] {
  const kept = logs.slice(0, CODE_LOG_MAX_LINES).map(boundLine);
  const dropped = logs.length - kept.length;
  return dropped > 0
    ? [...kept, `…[${dropped} more log lines omitted]`]
    : kept;
}

/**
 * 沙盒的原始回報 → 回給模型的形狀。**純函式**,是這個功能唯一被測到的收斂點。
 *
 * 三件事在這裡發生:
 *   1. resultJson 還原成真值(parse 不動就退成一段標注過的文字 —— 丟掉內容也要
 *      留下形狀,模型看得到「有東西但讀不到」);
 *   2. 超長的結果截斷並標注 —— 標注是重點,不是禮貌:模型把半份資料當成完整事實
 *      之後,後面每一句話都是基於那個事實;
 *   3. logs 收進上限。
 *
 * 空的 logs **不進輸出**(而不是帶一個空陣列):tool_result 是要送回上游的東西,
 * 一個永遠在的空欄位只是每一輪都在花 token。
 */
export function toCodeOutput(run: AgentCodeRun): AgentCodeOutput {
  const logs = boundLogs(run.logs);
  const base: AgentCodeOutput = {
    ok: run.ok,
    ...(logs.length > 0 ? { logs } : {}),
    ...(run.error === undefined ? {} : { error: run.error }),
  };

  if (run.resultJson === undefined) {
    return run.resultNote === undefined ? base : { ...base, note: run.resultNote };
  }

  if (run.resultJson.length > CODE_RESULT_MAX_CHARS) {
    // 截斷過的 JSON 一定 parse 不動,所以這裡刻意回**文字**並在 note 裡說清楚它是
    // 什麼。順帶告訴模型下一步該做什麼 —— 它手上有這段程式碼,改成算個摘要是它
    // 自己就能做到的事。
    return {
      ...base,
      result: `${run.resultJson.slice(0, CODE_RESULT_MAX_CHARS)}…`,
      note: `the result serialised to ${run.resultJson.length} characters, over the ${CODE_RESULT_MAX_CHARS}-character limit; \`result\` above is that JSON text cut short, not the value. Compute a summary (a count, a total, the first few entries) instead of returning the whole thing.`,
    };
  }

  try {
    return { ...base, result: JSON.parse(run.resultJson) as unknown };
  } catch {
    // 走不到這裡(resultJson 是沙盒用 JSON.stringify 產出的),但 parse 失敗不能
    // 讓整輪對話炸掉 —— 退成文字並標注。
    return {
      ...base,
      result: run.resultJson,
      note: "the result could not be parsed back from JSON; `result` above is the raw text.",
    };
  }
}
