import type { Locale } from "@/lib/i18n";
import { periodLabel, type ReportPeriod } from "@/lib/report-period";
import type { ResolvedDashboardCard } from "@/ext/dx/dashboard-cards";
import { ReportPeriodControl } from "@/components/admin/report/ReportPeriodControl";
import { ExtStatCard } from "./ExtStatCard";
import { ExtRecentCard } from "./ExtRecentCard";
import { ListCard } from "./ListCard";
import { TimeseriesCard } from "./TimeseriesCard";
import { DashboardWidget } from "./widgets";
import type { PluginCards } from "./widget-cards";

// 1.62.0:儀表板的插件區(「來自擴充功能」)。由上而下:
//   1. 期間控制 —— 整頁一個,管所有跟著期間的卡。只有一張跟著期間、而且是每日圖時,放在那張卡的標題旁
//      (跟 1.61.0 一樣);有兩張以上、或跟著期間的是數字卡時,放在這一區最上面。
//   2. 數字卡(自動換行的格子,每張至少 15rem)。
//   3. 每日圖(一張一整寬)。
//   4. 佔比(格子)。
//   5. 列表:宣告式的「最近更新」卡,再來是插件的 list 卡(格子,每張至少 22rem)。
// 每一排裡照插件、再照宣告的順序(ext/dx/dashboard-widgets.ts)。

export interface PluginSectionLabels {
  title: string;
  description: string;
  view: string;
  viewAll: string;
  listEmpty: string;
  recent: { viewAll: string; empty: string; published: string; draft: string };
}

interface PluginSectionProps {
  cards: PluginCards;
  recent: ResolvedDashboardCard[];
  period: ReportPeriod | null;
  /** 跟著期間的卡有幾張(決定期間控制放哪)。 */
  periodCards: number;
  today: string;
  now: number;
  locale: Locale;
  timeZone: string;
  labels: PluginSectionLabels;
}

const grid = (min: string) => ({ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${min}), 1fr))` });

export function hasPluginCards(cards: PluginCards, recent: readonly ResolvedDashboardCard[]): boolean {
  return Object.values(cards).some((list) => list.length > 0) || recent.length > 0;
}

export function PluginSection({ cards, recent, period, periodCards, today, now, locale, timeZone, labels }: PluginSectionProps) {
  const controlInCard = periodCards === 1 && cards.timeseries.length === 1;
  const controlRow = period !== null && periodCards > 0 && !controlInCard;
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-ink/90">{labels.title}</h2>
        <p className="text-[13px] text-ink/40">{labels.description}</p>
      </div>

      {controlRow && (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="py-1.5 text-[12.5px] tabular-nums text-ink/45">{periodLabel(period.from, period.to, today, locale)}</p>
          <ReportPeriodControl period={period} today={today} />
        </div>
      )}

      {cards.numbers.length > 0 && (
        <div className="grid gap-4" style={grid("15rem")}>
          {cards.numbers.map((card) => (
            <ExtStatCard key={card.key} card={card} locale={locale} labels={{ view: labels.view }} />
          ))}
        </div>
      )}

      {period &&
        cards.timeseries.map((card, i) => (
          <TimeseriesCard
            key={card.key}
            card={card}
            period={period}
            today={today}
            locale={locale}
            control={controlInCard}
            titleId={`dashboard-plugin-chart-${i}`}
          />
        ))}

      {cards.proportions.length > 0 && (
        <div className="grid gap-4" style={grid("15rem")}>
          {cards.proportions.map((card) => (
            <DashboardWidget key={card.key} preset={card.preset} data={card.data} />
          ))}
        </div>
      )}

      {recent.length + cards.lists.length > 0 && (
        <div className="grid gap-4" style={grid("22rem")}>
          {recent.map((card, i) => (
            <ExtRecentCard key={`${card.contentType}-${i}`} card={card} now={now} locale={locale} timeZone={timeZone} labels={labels.recent} />
          ))}
          {cards.lists.map((card) => (
            <ListCard key={card.key} card={card} now={now} locale={locale} timeZone={timeZone} labels={{ viewAll: labels.viewAll, empty: labels.listEmpty }} />
          ))}
        </div>
      )}
    </section>
  );
}
