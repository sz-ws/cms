import { cn } from "@/lib/utils";
import type { Locale } from "@/lib/i18n";
import { periodLabel, type ReportPeriod } from "@/lib/report-period";
import { ReportPeriodControl } from "@/components/admin/report/ReportPeriodControl";
import { TimeseriesChart } from "./widgets/TimeseriesChart";
import { DeltaPill } from "./widgets/DeltaPill";
import { SHADOW_RING } from "./styles";
import type { TimeseriesCardModel } from "./widget-cards";

// 1.62.0:儀表板上插件的每日卡(dashboardWidgets 的 timeseries;同一個 metric 的線合成一張)。整張寬:
// 標題與期間、期間控制(整頁只有一個:這張是唯一跟著期間的卡時放在這裡,否則在插件區最上面)、加總的卡寫
// 期間合計與比前一段、每日圖與圖例。伺服器元件;期間控制與圖是 client 元件。

interface TimeseriesCardProps {
  card: TimeseriesCardModel;
  period: ReportPeriod;
  /** 站台時區的今天(YYYY-MM-DD)。 */
  today: string;
  locale: Locale;
  /** 期間控制放在這張卡上。 */
  control: boolean;
  /** 標題的 id(整頁唯一)。 */
  titleId: string;
}

export function TimeseriesCard({ card, period, today, locale, control, titleId }: TimeseriesCardProps) {
  const { comparison } = card;
  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        "flex min-w-0 flex-col gap-4 rounded-[calc(16px*var(--admin-radius-scale,1))] bg-surface px-5 py-[18px]",
        SHADOW_RING,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-px">
          <h3 id={titleId} className="text-[15px] font-semibold tracking-[-0.01em] text-ink/90">
            {card.title}
          </h3>
          <p className="text-[12px] tabular-nums text-ink/40">{periodLabel(period.from, period.to, today, locale)}</p>
        </div>
        {control && <ReportPeriodControl period={period} today={today} />}
      </div>

      {card.total !== undefined && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-[32px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-ink/90 [overflow-wrap:anywhere]">
            {card.total}
          </span>
          {comparison?.kind === "delta" && <DeltaPill delta={comparison.delta} unit="%" />}
          {comparison?.kind === "note" && <span className="text-[12px] text-ink/40">{comparison.text}</span>}
        </div>
      )}

      <TimeseriesChart data={card.chart} locale={locale} />
    </section>
  );
}
