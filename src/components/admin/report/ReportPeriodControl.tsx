"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";
import {
  customPeriodProblem,
  MAX_REPORT_DAYS,
  REPORT_PARAMS,
  REPORT_PRESETS,
  reportPeriodParams,
  type ReportPeriod,
} from "@/lib/report-period";

// 1.61.0:報表的期間(儀表板的營業額卡、插件的報表頁共用)。期間放在網址(lib/report-period.ts
// 的 range / since / until),網址上其他的參數照留。
//   - 7 天 / 30 天 / 90 天 / 自訂 是一排按鈕(aria-pressed),Tab 走、Enter / 空白鍵按。
//     按下去那一段馬上亮,頁面在背景換資料。
//   - 自訂打開兩個日期欄與「套用」;日期不合規則時說哪裡不對,不換頁。
//   - 窄螢幕(375px)整排換行,日期欄各佔一行的一半。

type Choice = ReportPeriod["preset"];
type Problem = NonNullable<ReturnType<typeof customPeriodProblem>>;

export interface ReportPeriodControlProps {
  period: Pick<ReportPeriod, "preset" | "from" | "to">;
  /** 站台時區的今天(YYYY-MM-DD):日期欄的上限。 */
  today: string;
  className?: string;
}

const segment = (selected: boolean) =>
  cn(
    "inline-flex h-7 min-w-12 items-center justify-center rounded-[calc(7px*var(--admin-radius-scale,1))] px-2.5 text-[12.5px] font-medium whitespace-nowrap",
    "outline-none transition-[background-color,color,box-shadow,transform] duration-150 ease-out",
    "focus-visible:shadow-[0_0_0_2px_var(--admin-accent)]",
    selected
      ? "bg-surface text-ink/85 shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.08))]"
      : "text-ink/45 hover:text-ink/75 active:scale-[0.96]",
  );

const field =
  "h-8 w-full min-w-0 rounded-[calc(8px*var(--admin-radius-scale,1))] border border-ink/10 bg-surface px-2.5 text-[13px] tabular-nums text-ink/85 outline-none transition-[border-color,box-shadow] focus:border-ink/30 focus:shadow-[0_0_0_3px_rgba(0,0,0,0.05)]";

export function ReportPeriodControl({ period, today, className }: ReportPeriodControlProps) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const sinceRef = useRef<HTMLInputElement>(null);

  // 伺服器換好期間之後,畫面跟著網址(上一頁、下一頁也一樣)。
  const periodKey = `${period.preset}:${period.from}:${period.to}`;
  const [seen, setSeen] = useState(periodKey);
  const [chosen, setChosen] = useState<Choice>(period.preset);
  const [since, setSince] = useState(period.from);
  const [until, setUntil] = useState(period.to);
  const [problem, setProblem] = useState<Problem | null>(null);
  if (seen !== periodKey) {
    setSeen(periodKey);
    setChosen(period.preset);
    setSince(period.from);
    setUntil(period.to);
    setProblem(null);
  }

  function go(next: Record<string, string>) {
    const query = new URLSearchParams(params.toString());
    Object.values(REPORT_PARAMS).forEach((name) => query.delete(name));
    Object.entries(next).forEach(([name, value]) => query.set(name, value));
    startTransition(() => router.push(`${pathname}?${query}`, { scroll: false }));
  }

  function choosePreset(preset: (typeof REPORT_PRESETS)[number]) {
    setChosen(preset);
    setProblem(null);
    if (period.preset !== preset) go(reportPeriodParams({ preset, from: "", to: "" }));
  }

  function openCustom() {
    setChosen("custom");
    requestAnimationFrame(() => sinceRef.current?.focus());
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = customPeriodProblem(since, until, today);
    setProblem(found);
    if (found) return;
    if (period.preset !== "custom" || period.from !== since || period.to !== until) {
      go(reportPeriodParams({ preset: "custom", from: since, to: until }));
    }
  }

  const problemText =
    problem === "length" ? t("reportPeriod.error.length", { days: MAX_REPORT_DAYS }) : problem ? t(`reportPeriod.error.${problem}`) : "";

  return (
    <div className={cn("flex flex-col items-start gap-2", className)} aria-busy={pending || undefined}>
      <div
        role="group"
        aria-label={t("reportPeriod.label")}
        className="inline-flex flex-wrap gap-0.5 rounded-[calc(9px*var(--admin-radius-scale,1))] bg-ink/[0.045] p-0.5"
      >
        {REPORT_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-pressed={chosen === preset}
            onClick={() => choosePreset(preset)}
            className={segment(chosen === preset)}
          >
            {t("reportPeriod.days", { days: preset })}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={chosen === "custom"}
          aria-expanded={chosen === "custom"}
          onClick={openCustom}
          className={segment(chosen === "custom")}
        >
          {t("reportPeriod.custom")}
        </button>
      </div>

      {chosen === "custom" && (
        <form onSubmit={apply} noValidate className="flex w-full flex-col gap-1.5 sm:w-auto">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2">
            <label className="flex min-w-0 flex-col gap-1 text-[12px] text-ink/50">
              {t("reportPeriod.from")}
              <input
                ref={sinceRef}
                type="date"
                value={since}
                max={until || today}
                onChange={(event) => setSince(event.target.value)}
                aria-invalid={problem !== null || undefined}
                className={field}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-[12px] text-ink/50">
              {t("reportPeriod.to")}
              <input
                type="date"
                value={until}
                min={since || undefined}
                max={today}
                onChange={(event) => setUntil(event.target.value)}
                aria-invalid={problem !== null || undefined}
                className={field}
              />
            </label>
            <button
              type="submit"
              className="inline-flex h-8 items-center justify-center rounded-[calc(8px*var(--admin-radius-scale,1))] bg-ink px-3 text-[12.5px] font-medium text-surface outline-none transition-[background-color,transform] duration-150 hover:bg-ink/85 focus-visible:shadow-[0_0_0_2px_var(--admin-accent)] active:scale-[0.96]"
            >
              {t("reportPeriod.apply")}
            </button>
          </div>
          {problem && (
            <p role="alert" className="text-[12.5px] text-red-700">
              {problemText}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
