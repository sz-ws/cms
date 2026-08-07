"use client";

import { useId, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import { useImeGuard } from "@/lib/ime";
import { useT } from "@/lib/i18n/I18nProvider";
import { RingDot } from "@/components/admin/dashboard/RingDot";
import type { AgentAsk, AgentAskField } from "@/ext/agent-loop";
import type { AskAnswer, AskResolution } from "./transcript";

// docs/spec-admin-agent.md §4.6:反問卡。
//
// 確認卡問的是「這件事要不要做」,這張卡問的是「做之前少了什麼」。它存在的理由
// 很具體:模型缺一個它查不到的細節時,舊的兩條路都不好 —— 用猜的(下一步可能是
// 一個 write),或寫一段問句然後等 admin 打字。這裡給第三條:一組按得下去的選項,
// 或一份最小的表單,答案直接以 tool_result 回到 transcript 續跑。
//
// 視覺完全沿 ProposalCard 的語彙(同心圓角 20 → 14 → 8、shadow 造層次、靜態
// RingDot、黑底主動作、右對齊動作列),因為對 admin 而言這兩張卡是同一種東西:
// **對話停下來了,在等我**。兩套視覺只會讓「什麼時候該我動手」這件事變模糊。
//
// 動效紅線(CLAUDE.md):**沒有任何 pulsing / ping / 呼吸 / 閃爍**。進場只有一次
// opacity + y 位移,prefers-reduced-motion 時直接關掉。

interface AskCardProps {
  ask: AgentAsk;
  resolution: AskResolution;
  /** resolution:"answered" 時,admin 給了什麼(已解決的卡片據此顯示)。 */
  answer?: AskAnswer;
  /** 這張卡的回答已送出、正在續跑 /chat。 */
  running: boolean;
  onAnswer: (answer: AskAnswer) => void;
  onDismiss: () => void;
}

/** 動作列按鈕:同 ProposalCard 的兩種語氣(黑底主動作 / 白底次動作)。 */
function actionClasses(tone: "primary" | "secondary"): string {
  return cn(
    "inline-flex h-9 items-center gap-1.5 rounded-[8px] px-3.5 text-[13px] font-medium",
    "transition-[background-color,box-shadow,transform,opacity] duration-150 ease-out",
    "active:scale-[0.96] disabled:pointer-events-none disabled:opacity-45",
    tone === "primary"
      ? "bg-black text-white hover:bg-black/85"
      : "bg-white text-black/65 shadow-[0_0_0_1px_rgba(20,18,22,0.07),0_1px_2px_-1px_rgba(20,18,22,0.06)] hover:text-black/90",
  );
}

/** 輸入框:8px 圓角、shadow 造框(不是 border)、focus 時加一圈 accent 暈。 */
function inputClasses(invalid: boolean): string {
  return cn(
    "w-full rounded-[8px] bg-white px-2.5 py-2 text-[13px] leading-relaxed text-black/85",
    "outline-none placeholder:text-black/25",
    "transition-shadow duration-150 ease-out",
    invalid
      ? "shadow-[0_0_0_1px_rgba(220,38,38,0.35)]"
      : "shadow-[0_0_0_1px_rgba(20,18,22,0.08)] focus:shadow-[0_0_0_1px_rgba(20,18,22,0.12),0_0_0_3px_rgba(86,114,228,0.08)]",
  );
}

/** 選項按鈕。整列可按、文字靠左 —— 選項的長度不一,置中會讓清單讀起來是跳的。 */
function OptionButton({
  label,
  hint,
  disabled,
  onClick,
}: {
  label: string;
  hint?: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full flex-col items-start gap-0.5 rounded-[8px] bg-white px-3 py-2 text-left",
        "shadow-[0_0_0_1px_rgba(20,18,22,0.07),0_1px_2px_-1px_rgba(20,18,22,0.06)]",
        "transition-[box-shadow,transform,opacity] duration-150 ease-out",
        "hover:shadow-[0_0_0_1px_rgba(20,18,22,0.14),0_1px_2px_-1px_rgba(20,18,22,0.08)]",
        "active:scale-[0.985] disabled:pointer-events-none disabled:opacity-45",
      )}
    >
      <span className="text-[13.5px] leading-snug text-black/85">{label}</span>
      {hint && <span className="text-[11.5px] leading-snug text-black/40">{hint}</span>}
    </button>
  );
}

/** 已解決的卡片下方那一段:你回了什麼。灰化,同 ProposalCard 的 ResolutionLine。 */
function AnswerLine({
  ask,
  resolution,
  answer,
}: {
  ask: AgentAsk;
  resolution: AskResolution;
  answer?: AskAnswer;
}) {
  const t = useT();
  if (resolution === "dismissed") {
    return <p className="text-[12px] text-black/40">{t("agent.ask.dismissed")}</p>;
  }

  // choice 是 value(給模型的識別字),admin 看到的是 label —— 回顯時換回來,
  // 否則卡片會顯示一個他從來沒看過的字串。
  const chosen = ask.options?.find((o) => o.value === answer?.choice);
  const lines: { key: string; text: string }[] = [];
  if (answer?.choice !== undefined) {
    lines.push({ key: "choice", text: chosen?.label ?? answer.choice });
  }
  if (answer?.freeText) lines.push({ key: "freeText", text: answer.freeText });
  for (const field of ask.fields ?? []) {
    const value = answer?.values?.[field.key] ?? "";
    lines.push({ key: field.key, text: `${field.label}: ${value || "—"}` });
  }

  return (
    <div className="flex flex-col gap-1">
      <p className="text-[12px] text-black/40">{t("agent.ask.answered")}</p>
      {lines.map((line) => (
        <p key={line.key} className="text-[12.5px] leading-relaxed text-black/60">
          {line.text}
        </p>
      ))}
    </div>
  );
}

export function AskCard({
  ask,
  resolution,
  answer,
  running,
  onAnswer,
  onDismiss,
}: AskCardProps) {
  const t = useT();
  const ime = useImeGuard();
  const reduced = useReducedMotion();
  const fieldIdPrefix = useId();
  const [freeText, setFreeText] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  // 送出被必填擋下來過。擋下來之前不標紅 —— 一開啟就滿是紅框的表單是在罵人。
  const [showMissing, setShowMissing] = useState(false);

  const pending = resolution === "pending";
  const busy = running || !pending;
  const fields = ask.fields ?? [];

  function valueOf(field: AgentAskField): string {
    return values[field.key] ?? "";
  }

  function missing(field: AgentAskField): boolean {
    return field.required === true && valueOf(field).trim().length === 0;
  }

  function submitFields(): void {
    if (fields.some(missing)) {
      setShowMissing(true);
      return;
    }
    // **每個 key 都帶上**(沒填的是空字串),不是只帶有值的那幾個:模型要能分辨
    // 「這一欄留白」與「這一欄根本沒問」,前者是答案的一部分。
    onAnswer({
      values: Object.fromEntries(
        fields.map((field) => [field.key, valueOf(field).trim()]),
      ),
    });
  }

  const freeTextReady = freeText.trim().length > 0;

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "w-full max-w-[36rem] rounded-[20px] p-1.5 backdrop-blur-md",
        pending
          ? "bg-white/55 shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_16px_48px_-12px_rgba(30,20,50,0.18)]"
          : "bg-transparent",
      )}
    >
      <div
        className={cn(
          "flex flex-col gap-3.5 rounded-[14px] bg-white p-4",
          "shadow-[0_0_0_1px_rgba(20,18,22,0.055),0_1px_2px_-1px_rgba(20,18,22,0.06)]",
          !pending && "opacity-90",
        )}
      >
        <div className="flex items-center gap-2">
          {/* 靜態 ring-dot。等待中不閃、不跳、不呼吸 —— 見檔頭的動效紅線。 */}
          <RingDot accent={pending} />
          <span className="text-[11.5px] text-black/40">
            {pending
              ? t("agent.ask.heading")
              : resolution === "dismissed"
                ? t("agent.ask.dismissed")
                : t("agent.ask.answered")}
          </span>
        </div>

        <p className="text-[14px] leading-relaxed text-black/85">{ask.question}</p>

        {pending && (
          <>
            {ask.options && (
              <div className="flex flex-col gap-1.5">
                {ask.options.map((option) => (
                  <OptionButton
                    key={option.value}
                    label={option.label}
                    {...(option.hint ? { hint: option.hint } : {})}
                    disabled={busy}
                    onClick={() => onAnswer({ choice: option.value })}
                  />
                ))}
              </div>
            )}

            {ask.options && ask.allowFreeText && (
              <input
                type="text"
                value={freeText}
                disabled={busy}
                placeholder={t("agent.ask.otherPlaceholder")}
                aria-label={t("agent.ask.otherPlaceholder")}
                onChange={(e) => setFreeText(e.target.value)}
                onCompositionStart={ime.onCompositionStart}
                onCompositionEnd={ime.onCompositionEnd}
                onKeyDown={(e) => {
                  // 組字中的 Enter 是在確定候選字(見 @/lib/ime)。
                  if (ime.isComposingKey(e)) return;
                  if (e.key === "Enter" && freeTextReady && !busy) {
                    e.preventDefault();
                    onAnswer({ freeText: freeText.trim() });
                  }
                }}
                className={inputClasses(false)}
              />
            )}

            {fields.length > 0 && (
              <div className="flex flex-col gap-3">
                {fields.map((field) => {
                  const id = `${fieldIdPrefix}-${field.key}`;
                  const invalid = showMissing && missing(field);
                  const common = {
                    id,
                    value: valueOf(field),
                    disabled: busy,
                    placeholder: field.placeholder ?? "",
                    "aria-invalid": invalid,
                    "aria-required": field.required === true,
                    onChange: (
                      e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
                    ) => setValues((prev) => ({ ...prev, [field.key]: e.target.value })),
                    className: inputClasses(invalid),
                  };
                  return (
                    <div key={field.key} className="flex flex-col gap-1.5">
                      <label
                        htmlFor={id}
                        className="flex items-baseline gap-1.5 text-[12px] font-medium text-black/50"
                      >
                        {field.label}
                        {field.required && (
                          <span className="text-[11px] font-normal text-black/30">
                            {t("agent.ask.required")}
                          </span>
                        )}
                      </label>
                      {field.type === "textarea" ? (
                        <textarea rows={3} {...common} className={cn(common.className, "resize-y")} />
                      ) : (
                        <input type="text" {...common} />
                      )}
                    </div>
                  );
                })}
                {showMissing && fields.some(missing) && (
                  <p className="text-[11.5px] text-red-700">
                    {t("agent.ask.missingRequired")}
                  </p>
                )}
              </div>
            )}

            <p className="text-[11.5px] leading-relaxed text-black/35">
              {t("agent.ask.note")}
            </p>

            {/* 表單動作靠右,主動作最右(admin-design-language.md「Controls」)。 */}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onDismiss}
                disabled={busy}
                className={actionClasses("secondary")}
              >
                {t("agent.ask.dismiss")}
              </button>
              {fields.length > 0 && (
                <button
                  type="button"
                  onClick={submitFields}
                  disabled={busy}
                  className={actionClasses("primary")}
                >
                  {running ? t("agent.ask.sending") : t("agent.ask.submit")}
                </button>
              )}
              {ask.options && ask.allowFreeText && (
                <button
                  type="button"
                  onClick={() => onAnswer({ freeText: freeText.trim() })}
                  disabled={busy || !freeTextReady}
                  className={actionClasses("primary")}
                >
                  {running ? t("agent.ask.sending") : t("agent.ask.submit")}
                </button>
              )}
            </div>
          </>
        )}

        {!pending && <AnswerLine ask={ask} resolution={resolution} answer={answer} />}
      </div>
    </motion.div>
  );
}
