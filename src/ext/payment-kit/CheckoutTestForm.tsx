"use client";

import { useState } from "react";
import type { CheckoutSession } from "../capabilities";

// payment-kit:測試付款表單(client)。POST 到該金流 extension 的 checkout
// endpoint 拿 CheckoutSession —— form-post 型動態建 <form> 送出(整頁跳轉到
// gateway 付款頁),redirect 型直接導向。
//
// 按鈕忙碌狀態為靜態文字(無 pulsing / 呼吸動效 —— 專案紅線)。

const ERROR_HINT: Record<string, string> = {
  not_configured: "商店金鑰未設定或格式不對,先到設定頁補齊。",
  invalid_input: "輸入不合法:金額需為正整數,描述 1–50 字。",
  invalid_amount: "金額不合法(1–99,999,999 的整數)。",
  invalid_description: "描述長度需在 1–50 字之間。",
  invalid_order_no: "訂單編號不符 gateway 規則(extension bug,請回報)。",
};

/** 以 session 的 fields 建立 hidden form 並送出(離開本頁,前往 gateway 付款頁)。 */
function submitToGateway(
  gatewayUrl: string,
  fields: Record<string, string>,
): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = gatewayUrl;
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

export function CheckoutTestForm({
  endpoint,
  disabled,
}: {
  /** 該金流 extension 的 checkout API,如 "/api/ext/newebpay/checkout"。 */
  endpoint: string;
  disabled: boolean;
}) {
  const [amount, setAmount] = useState("100");
  const [description, setDescription] = useState("測試訂單");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: Number(amount),
          description: description.trim(),
          ...(email.trim() ? { email: email.trim() } : {}),
        }),
      });
      const session = (await res.json()) as CheckoutSession;
      if (session.ok && session.kind === "form-post") {
        submitToGateway(session.gatewayUrl, session.fields);
        return; // 頁面即將離開,busy 維持到跳轉。
      }
      if (session.ok) {
        window.location.href = session.url;
        return;
      }
      setError(ERROR_HINT[session.error] ?? `建立失敗:${session.error}`);
    } catch {
      setError("網路錯誤,請重試。");
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "w-full rounded-[8px] bg-white px-3 py-2 text-[13.5px] text-black/80 shadow-[0_0_0_1px_rgba(0,0,0,0.10)] outline-none transition-shadow focus:shadow-[0_0_0_1px_rgba(0,0,0,0.28)] disabled:bg-black/[0.03] disabled:text-black/35";

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[8rem_1fr_1fr]">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-black/45">金額(NT$)</span>
          <input
            type="number"
            min={1}
            max={99999999}
            step={1}
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={disabled || busy}
            className={`${inputClass} tabular-nums`}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-black/45">商品描述</span>
          <input
            type="text"
            maxLength={50}
            required
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={disabled || busy}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-black/45">Email(選填)</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={disabled || busy}
            className={inputClass}
          />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={disabled || busy}
          className="rounded-[8px] bg-black/85 px-4 py-2 text-[13px] font-medium text-white transition-[transform,opacity] active:scale-[0.96] disabled:opacity-40"
        >
          {busy ? "前往付款頁…" : "建立測試付款"}
        </button>
        {disabled && (
          <span className="text-[12.5px] text-black/45">
            先完成商店金鑰設定。
          </span>
        )}
      </div>

      {error && (
        <p className="text-[12.5px] text-red-700" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
