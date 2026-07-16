"use client";

import { useState } from "react";
import type { AiGenerateResult, AiStreamEvent } from "@/ext/providers/ai";

const CARD =
  "rounded-[14px] bg-white px-6 py-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]";

export function PromptForm() {
  const [prompt, setPrompt] = useState("用一句話介紹你自己。");
  const [streamingMode, setStreamingMode] = useState(false);
  const [pending, setPending] = useState(false);
  // 串流進行中(NDJSON 尚未收到 done/error)——只用來切換「串流中…」這個靜態
  // label,絕不做成 pulsing/animate-ping 之類的呼吸動畫(專案硬性紅線)。
  const [isStreaming, setIsStreaming] = useState(false);
  const [result, setResult] = useState<AiGenerateResult | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setResult(null);
    setNetworkError(null);
    setIsStreaming(false);
    try {
      if (streamingMode) {
        await submitStreaming();
      } else {
        await submitOnce();
      }
    } catch (err) {
      setNetworkError(err instanceof Error ? err.message : "network_error");
    } finally {
      setPending(false);
      setIsStreaming(false);
    }
  }

  async function submitOnce(): Promise<void> {
    const res = await fetch("/api/ext/ai-smoke-test/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const body = (await res.json()) as AiGenerateResult | { error: string };
    if ("ok" in body) {
      setResult(body);
    } else {
      setNetworkError(body.error);
    }
  }

  // 讀 /generate-stream 的 NDJSON body,逐行 parse 成 AiStreamEvent、逐步把 delta
  // 疊進同一個 result-display 區(與非 streaming 路徑共用 result state)——這是
  // 唯一目的:視覺上看到文字真的邊生成邊出現,而不是等全部完成才一次顯示。
  async function submitStreaming(): Promise<void> {
    const res = await fetch("/api/ext/ai-smoke-test/generate-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.body) {
      setNetworkError("empty_stream_body");
      return;
    }
    setIsStreaming(true);
    setResult({ ok: true, text: "" });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) applyStreamEvent(JSON.parse(line) as AiStreamEvent);
      }
    }
    const tail = buffer.trim();
    if (tail) applyStreamEvent(JSON.parse(tail) as AiStreamEvent);
  }

  function applyStreamEvent(event: AiStreamEvent): void {
    if (event.type === "delta") {
      setResult((prev) => ({ ok: true, text: (prev?.text ?? "") + event.text }));
      return;
    }
    if (event.type === "done") {
      setIsStreaming(false);
      setResult((prev) => ({ ok: true, text: prev?.text ?? "", model: event.model }));
      return;
    }
    // event.type === "error"
    setIsStreaming(false);
    setResult({ ok: false, error: event.error });
  }

  return (
    <section className={CARD}>
      <h2 className="mb-3 text-[15px] font-semibold tracking-[-0.01em] text-black/85">
        呼叫 ai:generate
      </h2>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          className="rounded-[10px] border-black/10 bg-white px-3 py-2 text-[13.5px] text-black/85 shadow-[0_0_0_1px_rgba(0,0,0,0.08)] outline-none transition-[box-shadow] focus:shadow-[0_0_0_1px_rgba(0,0,0,0.25),0_0_0_3px_rgba(0,0,0,0.05)]"
        />
        <label className="flex w-fit items-center gap-2 text-[13px] text-black/55">
          <input
            type="checkbox"
            checked={streamingMode}
            onChange={(e) => setStreamingMode(e.target.checked)}
            className="h-3.5 w-3.5 rounded-[4px] border-black/20 accent-black"
          />
          streaming
        </label>
        <button
          type="submit"
          disabled={pending || !prompt.trim()}
          className="inline-flex h-9 w-fit items-center justify-center rounded-[8px] bg-black px-4 text-[13px] font-medium text-white transition-[background-color,transform] duration-150 ease-out hover:bg-black/85 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45"
        >
          {isStreaming ? "串流中…" : pending ? "呼叫中…" : "送出"}
        </button>
      </form>

      {networkError && (
        <p className="mt-4 rounded-[10px] bg-red-600/[0.06] px-3 py-2 text-[13px] text-red-700">
          request 失敗:{networkError}
        </p>
      )}

      {result && (
        <div className="mt-4 flex flex-col gap-2 rounded-[10px] bg-black/[0.03] px-3 py-2.5">
          <div className="flex items-center gap-2">
            {isStreaming ? (
              <span className="inline-flex items-center rounded-full bg-black/[0.06] px-2.5 py-1 text-[11px] font-medium text-black/55">
                串流中…
              </span>
            ) : (
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium ${
                  result.ok
                    ? "bg-[rgba(16,145,90,0.10)] text-[rgb(18,124,88)]"
                    : "bg-amber-500/10 text-amber-700"
                }`}
              >
                {result.ok ? "ok" : "not ok"}
              </span>
            )}
            {result.model && (
              <span className="text-[12px] text-black/40">{result.model}</span>
            )}
          </div>
          {result.ok ? (
            <p className="whitespace-pre-wrap text-[13.5px] text-black/85">
              {result.text}
            </p>
          ) : (
            <p className="text-[13px] text-black/55">
              {result.error === "not_configured"
                ? "core.ai.mode 還沒設定——去設定頁的 Advanced 區填 provider/model/key 才會有真的回覆。"
                : result.error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
