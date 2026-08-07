import { describe, it, expect } from "vitest";

// docs/spec-admin-agent.md §4.7:JS 沙盒的**契約層**單元測試。
//
// 這一檔測的是 src/ext/agent-code.ts —— 參數 schema、給 LLM 的說明、以及
// 「沙盒吐出來的原始回報 → 回給模型的 tool_result 內容」那一段收斂。
//
// ── 為什麼契約與執行要分開,而這一半才測得到 ────────────────────────────────
// 測試跑在 workerd:**沒有 Web Worker、沒有 DOM、沒有瀏覽器的 WASM 載入路徑**。
// 真正跑 QuickJS 的那一層(components/admin/agent/code-sandbox*.ts)因此在這裡是
// 摸不到的。取捨是把所有有分支、有取捨的東西都擠到這一側來:結果怎麼還原、超過
// 上限怎麼截、logs 怎麼收 —— 全是純函式,全在下面被釘住。
// 剩下那一層薄到用眼睛看得完(開 worker、送一則訊息、等回應或逾時、terminate)。
//
// ── 為什麼 description 也要測 ────────────────────────────────────────────────
// 那段字是這個 tool 唯一的**使用說明**,而它最重要的一句是「拿不到站上的資料」。
// 少了它,模型會寫出 fetch('/api/…') 然後每一次都失敗 —— 而失敗的樣子看起來像
// 「沙盒壞了」,所以它會一直重試同一招。這句話被刪掉不會有任何測試變紅,除非
// 這裡有一條。

import {
  CODE_DESCRIPTION,
  CODE_LOG_LINE_MAX_CHARS,
  CODE_LOG_MAX_LINES,
  CODE_MAX_CHARS,
  CODE_REASON_MAX_CHARS,
  CODE_RESULT_MAX_CHARS,
  CODE_STACK_LIMIT_BYTES,
  CODE_TIMEOUT_MS,
  codeArgsSchema,
  toCodeOutput,
} from "../src/ext/agent-code";
import type { AgentCodeRun } from "../src/ext/agent-code";

// ---------------------------------------------------------------------------
// 參數
// ---------------------------------------------------------------------------

describe("core.code.run 的參數 schema", () => {
  it("最小形狀:只有 code", () => {
    const parsed = codeArgsSchema.safeParse({ code: "1 + 1" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("unreachable");
    expect(parsed.data).toEqual({ code: "1 + 1" });
  });

  it("reason 是選填的一句話", () => {
    const parsed = codeArgsSchema.safeParse({ code: "1", reason: "算出中位數" });
    expect(parsed.success).toBe(true);
  });

  it("空字串的 code 擋下來 —— 一張跑一段空白的卡片沒有意義", () => {
    expect(codeArgsSchema.safeParse({ code: "" }).success).toBe(false);
  });

  it("缺 code 擋下來", () => {
    expect(codeArgsSchema.safeParse({ reason: "算點什麼" }).success).toBe(false);
  });

  it("超長的 code / reason 擋下來(上限是 8,000 / 200)", () => {
    expect(CODE_MAX_CHARS).toBe(8_000);
    expect(
      codeArgsSchema.safeParse({ code: "x".repeat(CODE_MAX_CHARS) }).success,
    ).toBe(true);
    expect(
      codeArgsSchema.safeParse({ code: "x".repeat(CODE_MAX_CHARS + 1) }).success,
    ).toBe(false);
    expect(
      codeArgsSchema.safeParse({
        code: "1",
        reason: "字".repeat(CODE_REASON_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
  });

  it("多餘的鍵擋下來(.strict)—— 模型不能靠一個沒人看的欄位夾帶東西進來", () => {
    expect(
      codeArgsSchema.safeParse({ code: "1", timeoutMs: 999_999 }).success,
    ).toBe(false);
  });
});

describe("給 LLM 的說明", () => {
  it("講死了三件事:沒有網路、拿不到站上的資料、要先用 read tool 撈回來", () => {
    expect(CODE_DESCRIPTION).toContain("NO network");
    expect(CODE_DESCRIPTION).toContain("no fetch");
    expect(CODE_DESCRIPTION).toContain("NO access to this site's data");
    expect(CODE_DESCRIPTION).toContain("first fetch it with a read tool");
  });

  it("也講了三個最容易錯的機制:最後一個運算式、乾淨的直譯器、會逾時", () => {
    expect(CODE_DESCRIPTION).toContain("last expression");
    expect(CODE_DESCRIPTION).toContain("clean interpreter");
    expect(CODE_DESCRIPTION).toContain("aborted after");
  });
});

describe("常數", () => {
  it("逾時是 5 秒(spec §4.7 的表)", () => {
    expect(CODE_TIMEOUT_MS).toBe(5_000);
  });

  it("堆疊上限 ≤ 256 KB —— 這是量出來的,調大會讓宿主先爆", () => {
    // 實測(Node 26 + quickjs-emscripten-core 0.32):≥512 KB 時無窮遞迴會丟宿主的
    // RangeError,而且後續的 runtime.dispose() 會讓整個 WASM 模組 abort。
    // 這條測試擋的不是「今天的值」,是**未來有人把它調大**。
    expect(CODE_STACK_LIMIT_BYTES).toBeLessThanOrEqual(256 * 1024);
  });
});

// ---------------------------------------------------------------------------
// 結果收斂
// ---------------------------------------------------------------------------

/** 沙盒的原始回報:預設是一次乾淨的成功。 */
function run(patch: Partial<AgentCodeRun> = {}): AgentCodeRun {
  return { ok: true, logs: [], ...patch };
}

describe("toCodeOutput:結果還原成真值", () => {
  it("數字回來就是數字,不是字串 —— 模型不該再 parse 一次", () => {
    const out = toCodeOutput(run({ resultJson: "42" }));
    expect(out).toEqual({ ok: true, result: 42 });
    expect(typeof out.result).toBe("number");
  });

  it("陣列與物件原樣還原", () => {
    expect(toCodeOutput(run({ resultJson: '[1,2,3]' })).result).toEqual([1, 2, 3]);
    expect(toCodeOutput(run({ resultJson: '{"median":7.5}' })).result).toEqual({
      median: 7.5,
    });
  });

  it("null 是一個值,不是缺席", () => {
    const out = toCodeOutput(run({ resultJson: "null" }));
    expect(out.result).toBeNull();
    expect("result" in out).toBe(true);
  });

  it("沒有結果時帶著理由回去(而不是安靜地少一個鍵)", () => {
    const out = toCodeOutput(
      run({ resultNote: "the last expression evaluated to undefined — …" }),
    );
    expect(out.ok).toBe(true);
    expect(out.result).toBeUndefined();
    expect(out.note).toContain("undefined");
  });

  it("resultJson 壞掉時退成文字並標注(不讓一輪對話因此炸掉)", () => {
    const out = toCodeOutput(run({ resultJson: "{not json" }));
    expect(out.result).toBe("{not json");
    expect(out.note).toContain("could not be parsed");
  });
});

describe("toCodeOutput:超過上限就截斷並**標注**", () => {
  // 標注不是禮貌:模型看不到自己收到的是半份資料時,會把它當成完整事實,然後
  // 後面每一句話都是基於那個事實。
  const huge = JSON.stringify(Array.from({ length: 5_000 }, (_, i) => i));

  it("超長結果被截成文字,並說清楚它是被切過的 JSON", () => {
    expect(huge.length).toBeGreaterThan(CODE_RESULT_MAX_CHARS);
    const out = toCodeOutput(run({ resultJson: huge }));
    expect(typeof out.result).toBe("string");
    expect((out.result as string).length).toBe(CODE_RESULT_MAX_CHARS + 1); // +1 是那個「…」
    expect(out.note).toContain(String(huge.length));
    expect(out.note).toContain("cut short");
    // 而且告訴它下一步該做什麼 —— 程式碼在它手上,改成算個摘要是它自己做得到的。
    expect(out.note).toContain("Compute a summary");
  });

  it("剛好等於上限的結果不截斷", () => {
    // 一個序列化後長度恰為上限的字串常值。
    const exact = JSON.stringify("y".repeat(CODE_RESULT_MAX_CHARS - 2));
    expect(exact.length).toBe(CODE_RESULT_MAX_CHARS);
    const out = toCodeOutput(run({ resultJson: exact }));
    expect(out.note).toBeUndefined();
    expect(out.result).toBe("y".repeat(CODE_RESULT_MAX_CHARS - 2));
  });

  it("logs 的行數與單行長度各有上限,砍掉的行數要說出來", () => {
    const out = toCodeOutput(
      run({
        logs: [
          "z".repeat(CODE_LOG_LINE_MAX_CHARS + 50),
          ...Array.from({ length: CODE_LOG_MAX_LINES + 9 }, (_, i) => `line ${i}`),
        ],
      }),
    );
    const logs = out.logs ?? [];
    // 保留的行數 + 一行說明。
    expect(logs).toHaveLength(CODE_LOG_MAX_LINES + 1);
    expect(logs[0]!.length).toBe(CODE_LOG_LINE_MAX_CHARS + 1);
    expect(logs[logs.length - 1]).toBe("…[10 more log lines omitted]");
  });

  it("沒有 log 就不帶那個鍵 —— 一個永遠在的空陣列只是每輪都在花 token", () => {
    expect("logs" in toCodeOutput(run({ resultJson: "1" }))).toBe(false);
  });
});

describe("toCodeOutput:失敗一樣是一份完整的回報", () => {
  it("ok:false + error,而且**已經收集到的 logs 照樣送回去**", () => {
    // 一段跑到一半被中斷的程式碼,它印出來的東西往往正好指出它卡在哪裡。
    const out = toCodeOutput(
      run({ ok: false, error: "RangeError: too much recursion", logs: ["step 1", "step 2"] }),
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain("RangeError");
    expect(out.logs).toEqual(["step 1", "step 2"]);
    expect(out.result).toBeUndefined();
  });

  it("純函式:同輸入同輸出,而且不修改輸入", () => {
    const input = run({ resultJson: "[1,2]", logs: ["a"] });
    const snapshot = structuredClone(input);
    expect(toCodeOutput(input)).toEqual(toCodeOutput(structuredClone(snapshot)));
    expect(input).toEqual(snapshot);
  });
});
