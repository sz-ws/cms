import { cn } from "@/lib/utils";
import { format, type Locale } from "@/lib/i18n";
import { formatMoney } from "@/ext/commerce-kit/money";
import { ReportPeriodControl } from "@/components/admin/report/ReportPeriodControl";
import { RevenueChart } from "@/components/admin/report/RevenueChart";
import { periodLabel, revenueChange } from "@/components/admin/report/revenue-summary";
import { DeltaPill } from "./widgets/DeltaPill";
import { SHADOW_RING } from "./styles";
import type { DashboardRevenueData } from "./revenue-data";

// 1.61.0:儀表板的營業額卡(插件的 dashboardRevenue 疊成一張圖)。整張寬,放在插件的數字卡後面:
// 標題與期間、期間控制(網址是狀態)、這段期間的合計與比前一段、每日疊加長條圖與圖例。
// 伺服器元件;期間控制與圖是 client 元件(自己走 useT)。

export interface RevenueCardLabels {
  title: string;
  /** 「比前 {days} 天」 */
  vsPrevious: string;
  vsPreviousDay: string;
  /** 「前 {days} 天沒有營業額」 */
  noPrevious: string;
  noPreviousDay: string;
}

interface RevenueCardProps {
  data: DashboardRevenueData;
  /** 站台時區的今天(YYYY-MM-DD)。 */
  today: string;
  locale: Locale;
  labels: RevenueCardLabels;
}

function Comparison({ data, labels }: Pick<RevenueCardProps, "data" | "labels">) {
  if (data.previousTotal === null) return null;
  const days = data.period.days.length;
  const change = revenueChange(data.total, data.previousTotal);
  if (change) {
    const caption = days === 1 ? labels.vsPreviousDay : format(labels.vsPrevious, { days });
    return <DeltaPill delta={{ value: change.percent, direction: change.direction, caption }} unit="%" />;
  }
  if (data.total === 0) return null;
  return (
    <span className="text-[12px] text-ink/40">{days === 1 ? labels.noPreviousDay : format(labels.noPrevious, { days })}</span>
  );
}

export function RevenueCard({ data, today, locale, labels }: RevenueCardProps) {
  const { period } = data;
  return (
    <section
      aria-labelledby="dashboard-revenue-title"
      className={cn(
        "flex min-w-0 flex-col gap-4 rounded-[calc(16px*var(--admin-radius-scale,1))] bg-surface px-5 py-[18px]",
        SHADOW_RING,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-px">
          <h3 id="dashboard-revenue-title" className="text-[15px] font-semibold tracking-[-0.01em] text-ink/90">
            {labels.title}
          </h3>
          <p className="text-[12px] tabular-nums text-ink/40">{periodLabel(period.from, period.to, today, locale)}</p>
        </div>
        <ReportPeriodControl period={period} today={today} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[32px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-ink/90 [overflow-wrap:anywhere]">
          {formatMoney(data.total)}
        </span>
        <Comparison data={data} labels={labels} />
      </div>

      <RevenueChart
        days={period.days}
        series={data.series.map(({ key, label, href, days }) => ({ key, label, href, days }))}
        locale={locale}
      />
    </section>
  );
}
