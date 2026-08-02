"use client";

import { useState } from "react";
import type { TestEventResult } from "./test-route";

// 「送一筆測試事件」按鈕。
//
// 只做一件事,而且刻意把結果講到不能再具體:成功就給 event id(拿去 GlitchTip 上
// 貼進搜尋框就找得到那一筆),失敗就說是哪一種失敗。一顆只會變成「✓ 已送出」的按鈕
// 沒有價值 —— 它證明的只是「按鈕會動」,而不是「事件真的到得了對面」。

const CARD_INSET = "mt-4 rounded-[10px] px-3 py-2.5 text-[13px]";

export function TestEventButton({ disabled }: { disabled: boolean }) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<TestEventResult | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);

  async function send() {
    setPending(true);
    setResult(null);
    setNetworkError(null);
    try {
      const res = await fetch("/api/ext/sentry/test-event", { method: "POST" });
      const body = (await res.json()) as TestEventResult | { error: string };
      if ("ok" in body) setResult(body);
      else setNetworkError(body.error);
    } catch (err) {
      setNetworkError(err instanceof Error ? err.message : "network_error");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={send}
        disabled={pending || disabled}
        className="inline-flex h-9 w-fit items-center justify-center rounded-[8px] bg-black px-4 text-[13px] font-medium text-white transition-[background-color,transform] duration-150 ease-out hover:bg-black/85 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45"
      >
        {pending ? "送出中…" : "送出測試事件"}
      </button>

      {disabled && (
        <p className="mt-3 text-[12.5px] text-black/45">
          先填 DSN 才有地方可以送。
        </p>
      )}

      {networkError && (
        <p className={`${CARD_INSET} bg-red-600/[0.06] text-red-700`}>
          請求失敗:{networkError}
        </p>
      )}

      {result?.ok && (
        <div className={`${CARD_INSET} bg-black/[0.03] text-black/70`}>
          <p>
            送出了。到 GlitchTip 用這個 event id 找:
          </p>
          <code className="mt-1 block break-all font-mono text-[12.5px] text-black/85">
            {result.eventId ?? "(SDK 沒有回傳 id)"}
          </code>
          <p className="mt-2 text-[12.5px] text-black/45">
            幾秒內沒出現在收集端的話,問題就在 CMS 之外了(DSN 指錯專案、
            GlitchTip 沒在跑、或 Worker 出不去外網)。
          </p>
        </div>
      )}

      {result && !result.ok && (
        <div className={`${CARD_INSET} bg-amber-500/[0.08] text-amber-800`}>
          {result.reason === "not_sending" ? (
            <p>
              沒有送出 —— 目前的判定是不送(環境層級{" "}
              <code className="font-mono text-[12px]">{result.layer}</code>
              )。上方「狀態」那一區寫了是哪一個環節擋下來的。
            </p>
          ) : (
            <p>
              SDK 在送出時丟出例外。Worker 的 log 裡有完整訊息;把{" "}
              <code className="font-mono text-[12px]">CMS_ERROR_DEBUG=1</code>{" "}
              打開可以看到每一次傳輸的結果 ——「沒送出去」和「送出去但被對面丟掉」
              在這一頁看起來是一樣的。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
