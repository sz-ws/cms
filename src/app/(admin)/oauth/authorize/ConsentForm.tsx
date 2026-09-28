"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n/I18nProvider";
import { cn } from "@/lib/utils";

// 同意畫面的選項與按鈕。送出 → POST /api/oauth/authorize → 拿到要回去的網址 → 導過去
// (見該 route 的檔頭:用導航而不是表單送出)。
//
// 預設選「只能查看」:少給的那一邊。「可以查看與修改」只在這個人能給的時候出現。

type Access = "read" | "write";

interface ConsentFormProps {
  ticket: string;
  canWrite: boolean;
  /** 按下後會回到的地方(claude.ai、chatgpt.com…),讓人認得出這是不是他剛剛在用的 App。 */
  returnHost: string;
}

function errorKey(code: unknown): "consent.error.expired" | "consent.error.generic" {
  return code === "expired" || code === "unknown_client" ? "consent.error.expired" : "consent.error.generic";
}

export function ConsentForm({ ticket, canWrite, returnHost }: ConsentFormProps) {
  const t = useT();
  const [access, setAccess] = useState<Access>("read");
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "deny") {
    setPending(decision);
    setError(null);
    try {
      const res = await fetch("/api/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket, decision, access }),
      });
      const body = (await res.json().catch(() => null)) as { redirect?: unknown; error?: unknown } | null;
      if (res.ok && typeof body?.redirect === "string") {
        // 不清 pending:離開頁面之前按鈕維持「處理中」,免得被按第二次。
        window.location.assign(body.redirect);
        return;
      }
      setError(t(errorKey(body?.error)));
    } catch {
      setError(t("consent.error.generic"));
    }
    setPending(null);
  }

  const options: { value: Access; label: string; desc: string }[] = [
    { value: "read", label: t("consent.read"), desc: t("consent.readDesc") },
    ...(canWrite ? [{ value: "write" as const, label: t("consent.write"), desc: t("consent.writeDesc") }] : []),
  ];

  return (
    <div className="mt-6 flex flex-col gap-5">
      {options.length > 1 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-[13px] font-medium text-black/60">{t("consent.choice")}</legend>
          {options.map((option) => (
            <label
              key={option.value}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-[10px] bg-white px-4 py-3 shadow-[0_0_0_1px_rgba(0,0,0,0.1)] transition-shadow duration-150",
                access === option.value && "shadow-[0_0_0_1.5px_rgba(0,0,0,0.85)]",
              )}
            >
              <input
                type="radio"
                name="access"
                value={option.value}
                checked={access === option.value}
                onChange={() => setAccess(option.value)}
                className="mt-1 accent-black"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-[14px] font-medium text-black/85">{option.label}</span>
                <span className="text-[12.5px] leading-relaxed text-black/50">{option.desc}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {error && (
        <p role="alert" className="text-[13px] text-red-700">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void decide("approve")}
          className="h-10 flex-1 cursor-pointer rounded-[10px] bg-black px-4 text-[14px] font-medium text-white transition-[background-color,transform] duration-150 hover:bg-black/85 active:scale-[0.98] disabled:cursor-default disabled:opacity-60"
        >
          {pending === "approve" ? t("consent.working") : t("consent.allow")}
        </button>
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void decide("deny")}
          className="h-10 flex-1 cursor-pointer rounded-[10px] bg-white px-4 text-[14px] font-medium text-black/70 shadow-[0_0_0_1px_rgba(0,0,0,0.12)] transition-[box-shadow,transform] duration-150 hover:shadow-[0_0_0_1px_rgba(0,0,0,0.25)] active:scale-[0.98] disabled:cursor-default disabled:opacity-60"
        >
          {pending === "deny" ? t("consent.working") : t("consent.deny")}
        </button>
      </div>

      <p className="text-[12px] leading-relaxed text-black/40">
        {t("consent.returnTo", { host: returnHost })} {t("consent.revokeLater")}
      </p>
    </div>
  );
}
