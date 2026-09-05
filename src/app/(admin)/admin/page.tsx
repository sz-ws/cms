import { getDashboardData } from "@/components/admin/dashboard/aggregate";
import { OverviewBand } from "@/components/admin/dashboard/OverviewBand";
import { ContentTypeCard } from "@/components/admin/dashboard/ContentTypeCard";
import { RecentEntries } from "@/components/admin/dashboard/RecentEntries";
import { DashboardEmpty } from "@/components/admin/dashboard/DashboardEmpty";
import { QuickCreate } from "@/components/admin/dashboard/QuickCreate";
import { ExtStatCard } from "@/components/admin/dashboard/ExtStatCard";
import { ExtRecentCard } from "@/components/admin/dashboard/ExtRecentCard";
import {
  getWeeklyActivity,
  getStorageStats,
  getDatabaseStats,
  formatBytes,
  D1_QUOTA_BYTES,
  type D1Plan,
} from "@/components/admin/dashboard/widget-data";
import type { ProportionWidgetData } from "@/components/admin/dashboard/widgets";
import { DashboardInsights } from "@/components/admin/dashboard/DashboardInsights";
import { normalizeInsightConfig } from "@/lib/dashboard-insights-config";
import { getExtRuntime } from "@/ext/loader";
import { resolveDashboardCards } from "@/ext/dx/dashboard-cards";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { getSetting } from "@/lib/settings";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Task #4: content-aware dashboard. Everything below is driven by the enabled
// declarative extensions + the ContentProvider (see aggregate.ts) — it reflects
// whatever content types exist with no per-extension code. Server component;
// auth is enforced by the (admin) layout. All aggregation happens server-side;
// the only client bits are NumberFlow counts and the QuickCreate menu.
//
// LAYOUT (ported from the signed-off mock): a 3-col CSS grid where cards take
// variable widths via grid-column spans — the overview band and the recent-
// activity card span all 3 columns (full width); per-type cards span 1. Under
// 760px it collapses to a single column. This is the STATIC rendered result of
// the composable-dashboard direction; drag / resize / edit-mode / the card
// palette are a later phase and deliberately not built here.
export default async function DashboardPage() {
  const data = await getDashboardData();
  const locale = await getLocale();
  const m = getMessages(locale);

  // Server components 吃不到 context,dashboard 卡片是 server-rendered,
  // 所以這裡把字串收成 labels props 下發(client 元件才走 useT)。
  const labels = {
    dashboard: m["dashboard.title"],
    withTypes: m["dashboard.subtitle.withTypes"],
    empty: m["dashboard.subtitle.empty"],
    fromExtensions: m["dashboard.fromExtensions"],
    fromExtensionsDesc: m["dashboard.fromExtensionsDesc"],
    overview: {
      totalContent: m["overview.totalContent"],
      published: m["overview.published"],
      draft: m["overview.draft"],
      drafts: m["overview.drafts"],
      contentTypes: m["overview.contentTypes"],
      users: m["overview.users"],
    },
    contentType: {
      published: m["contentType.published"],
      draft: m["contentType.draft"],
      drafts: m["contentType.drafts"],
      new: m["contentType.new"],
      viewAll: m["contentType.viewAll"],
      ofAllContent: m["contentType.ofAllContent"],
      allPublished: m["contentType.allPublished"],
      awaitingReview: m["contentType.awaitingReview"],
    },
    recent: {
      title: m["recent.title"],
      subtitle: m["recent.subtitle"],
      empty: m["recent.empty"],
      published: m["contentType.published"],
      draft: m["contentType.draft"],
    },
    extRecent: {
      viewAll: m["contentType.viewAll"],
      empty: m["recent.empty"],
      published: m["contentType.published"],
      draft: m["contentType.draft"],
    },
    dashboardEmpty: {
      title: m["dashboardEmpty.title"],
      desc: m["dashboardEmpty.desc"],
      browseExtensions: m["dashboardEmpty.browseExtensions"],
    },
    widgets: {
      title: m["dashboard.widgets.title"],
      subtitle: m["dashboard.widgets.subtitle"],
      distribution: m["dashboard.widgets.distribution"],
      activity: m["dashboard.widgets.activity"],
      activityCaption: m["dashboard.widgets.activityCaption"],
      storage: m["dashboard.widgets.storage"],
      storageMore: m["dashboard.widgets.storageMore"],
      database: m["dashboard.widgets.database"],
      databaseQuota: m["dashboard.widgets.databaseQuota"],
    },
  };

  // DashboardInsights(編輯模式)專用的 labels 形狀,跟上面 labels.widgets(給
  // storage 標籤字串拼接用)分開放,避免兩種消費端的形狀互相牽扯。
  const insightsLabels = {
    title: m["dashboard.widgets.title"],
    subtitle: m["dashboard.widgets.subtitle"],
    edit: m["dashboard.widgets.edit"],
    done: m["dashboard.widgets.done"],
    cancel: m["dashboard.widgets.cancel"],
    show: m["dashboard.widgets.show"],
    hide: m["dashboard.widgets.hide"],
    moveUp: m["dashboard.widgets.moveUp"],
    moveDown: m["dashboard.widgets.moveDown"],
    style: m["dashboard.widgets.style"],
    empty: m["dashboard.widgets.empty"],
    widget: {
      activity: m["dashboard.widgets.activity"],
      distribution: m["dashboard.widgets.distribution"],
      storage: m["dashboard.widgets.storage"],
      database: m["dashboard.widgets.database"],
    },
    preset: {
      donut: m["dashboard.widgets.preset.donut"],
      "bar-list": m["dashboard.widgets.preset.bar-list"],
      "progress-ring": m["dashboard.widgets.preset.progress-ring"],
      "progress-segments": m["dashboard.widgets.preset.progress-segments"],
      "proportion-bar": m["dashboard.widgets.preset.proportion-bar"],
      "trend-bars": m["dashboard.widgets.preset.trend-bars"],
      "trend-sparkline": m["dashboard.widgets.preset.trend-sparkline"],
      "stat-simple": m["dashboard.widgets.preset.stat-simple"],
    },
  };

  // roadmap #16: composable dashboard. Resolve any dashboard cards contributed by
  // enabled extensions (getExtRuntime is React-cached per request — getDashboardData
  // already warmed it). Split by kind so stat tiles and recent feeds each get a
  // fitting responsive grid. Rendered only when non-empty.
  const rt = await getExtRuntime();
  const extCards = await resolveDashboardCards(rt.enabled, locale);
  const extStatCards = extCards.filter((c) => c.kind === "stat");
  const extRecentCards = extCards.filter((c) => c.kind === "recent");

  // Widget preset 家族的真實資料接線(取代舊的 SystemView 開發殘留 —— 那段是
  // FluidTabs 的展示殘留,Usage/Revenue/Activity 三個假 tab 沒有接任何資料,
  // 已整段刪除)。內容分佈跟上面 per-type 卡片的數字確實重疊,但 Suko 回饋
  // 要留著(視覺上是這頁做得最好的一塊,別為了除重複反而拿掉好看的東西)——
  // 用真數字圖表取代 per-type 卡片裡原本純裝飾的 motif band 那塊重複感才是
  // 該解的問題(見 CardMotif.tsx 改動)。
  //   · 內容分佈:type 數 ≤4 用 donut,更多用 bar-list(donut 切太細會失焦)。
  //   · 兩週活躍度:trend-bars,真實每日建立筆數。
  //   · 儲存空間:stat-simple(R2 無固定配額,progress-ring/segments 需要一個
  //     total 才有意義,虛構一個上限對使用者是誤導,故意不用)。
  //   · 資料庫用量:D1 有真實 hard limit(free 500MB / paid 10GB,超過寫不進去),
  //     所以與 storage(R2 無配額)相反,progress-ring 是正確的預設 —— 平常安靜,
  //     接近上限時一眼看得出來。方案由 core.d1.plan 設定(free|paid,預設 free)。
  // 先讀使用者的 widget 開關，再決定要不要打 D1/R2。舊路徑先把四份資料全抓完
  // 才讀 config，導致已隱藏的 storage 卡仍最多做 5 次 R2 ListObjects。
  const insightConfig = normalizeInsightConfig(
    await getSetting<unknown>("core.dashboard.insights", []),
  );
  const insightEnabled = (id: (typeof insightConfig)[number]["id"]) =>
    insightConfig.some((entry) => entry.id === id && entry.enabled);

  const [weeklyActivity, storageStats, dbStats, d1PlanRaw] = data.hasTypes
    ? await Promise.all([
        insightEnabled("activity") ? getWeeklyActivity(data.now) : null,
        insightEnabled("storage") ? getStorageStats() : null,
        insightEnabled("database") ? getDatabaseStats() : null,
        insightEnabled("database")
          ? getSetting<string>("core.d1.plan", "free")
          : "free",
      ])
    : [null, null, null, "free"];
  const d1Plan: D1Plan = d1PlanRaw === "paid" ? "paid" : "free";
  const d1Quota = D1_QUOTA_BYTES[d1Plan];

  // 洞察區的編輯模式寫的是 core.dashboard.insights,而 PUT /api/settings 是
  // requireAuth("admin")。editor 進得來這頁(layout 只擋 guest),所以權限要在這裡
  // 判,不然按下編輯只會走到一個必定 403 的死路。getSessionUser 有 React cache(),
  // layout 這個 request 已經呼叫過,這裡不會多一次查詢。
  const canEditInsights = (await getSessionUser())?.role === "admin";

  const distributionData: ProportionWidgetData | null = data.hasTypes
    ? {
        label: labels.widgets.distribution,
        segments: data.types.map((t) => ({
          id: t.typeKey,
          label: t.typeLabel,
          value: t.total,
        })),
      }
    : null;
  const distributionPreset = data.types.length > 4 ? "bar-list" : "donut";

  const quickOptions = data.types.map((t) => ({
    label: t.typeLabel,
    extName: t.extName,
    href: t.newHref,
  }));

  return (
    <div className="flex flex-col gap-5">
      {/* Page header — 21px title voice, not text-2xl bold. */}
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-black/90">
            {labels.dashboard}
          </h1>
          <p className="text-[13.5px] text-black/40">
            {data.hasTypes ? labels.withTypes : labels.empty}
          </p>
        </div>
        {/* Create menu only when there's more than one type to choose from. */}
        {data.types.length > 1 && <QuickCreate options={quickOptions} />}
      </div>

      {data.hasTypes ? (
        // Overview + recent span the full width; the per-type cards sit in a
        // CONTAINER-responsive auto-fit grid (each card ≥15rem, wraps to fewer
        // columns as the main area narrows — so it adapts to the real content
        // width, not the viewport, and never squeezes a card's text). Inline
        // grid-template avoids a complex Tailwind arbitrary value.
        <div className="flex flex-col gap-4">
          <OverviewBand
            totalEntries={data.totalEntries}
            totalPublished={data.totalPublished}
            totalDrafts={data.totalDrafts}
            typeCount={data.typeCount}
            userCount={data.userCount}
            labels={labels.overview}
          />

          {/* Per-type cards are NO LONGER a uniform auto-fit grid of clones.
              data.types is sorted by volume (aggregate.ts), so types[0] is the
              busiest type — it becomes a full-width HERO (halo shell + horizontal
              proportion bar), a real hierarchy driven by actual signal. The rest
              sit in a compact grid, each rendering the variant its own data shape
              warrants (ratio ring / inbox / settled) — see ContentTypeCard. */}
          {(() => {
            const [lead, ...rest] = data.types;
            const shareOfTotal =
              data.totalEntries > 0 ? lead.total / data.totalEntries : 0;
            return (
              <>
                <ContentTypeCard
                  key={lead.typeKey}
                  stats={lead}
                  labels={labels.contentType}
                  emphasis="hero"
                  shareOfTotal={shareOfTotal}
                />
                {rest.length > 0 && (
                  <div
                    className="grid gap-4"
                    style={{
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(min(100%, 15rem), 1fr))",
                    }}
                  >
                    {rest.map((t) => (
                      <ContentTypeCard
                        key={t.typeKey}
                        stats={t}
                        labels={labels.contentType}
                      />
                    ))}
                  </div>
                )}
              </>
            );
          })()}

          <RecentEntries
            entries={data.recent}
            now={data.now}
            locale={locale}
            labels={labels.recent}
          />
        </div>
      ) : (
        <DashboardEmpty labels={labels.dashboardEmpty} />
      )}

      {/* roadmap #16: extension-contributed cards. Only rendered when at least one
          enabled extension declares dashboardCards. Stat tiles sit in the same
          container-responsive auto-fit grid as the core per-type cards; recent
          feeds get a wider min column so their rows breathe. */}
      {extCards.length > 0 && (
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-black/90">
              {labels.fromExtensions}
            </h2>
            <p className="text-[13px] text-black/40">
              {labels.fromExtensionsDesc}
            </p>
          </div>

          {extStatCards.length > 0 && (
            <div
              className="grid gap-4"
              style={{
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 15rem), 1fr))",
              }}
            >
              {extStatCards.map((c, i) => (
                <ExtStatCard key={`${c.contentType}-${i}`} card={c} />
              ))}
            </div>
          )}

          {extRecentCards.length > 0 && (
            <div
              className="grid gap-4"
              style={{
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 22rem), 1fr))",
              }}
            >
              {extRecentCards.map((c, i) => (
                <ExtRecentCard
                  key={`${c.contentType}-${i}`}
                  card={c}
                  now={data.now}
                  locale={locale}
                  labels={labels.extRecent}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {distributionData && (
        <DashboardInsights
          config={insightConfig}
          canEdit={canEditInsights}
          widgetData={{
            activity: weeklyActivity
              ? {
                  ...weeklyActivity,
                  label: labels.widgets.activity,
                  delta: weeklyActivity.delta
                    ? {
                        ...weeklyActivity.delta,
                        caption: labels.widgets.activityCaption,
                      }
                    : undefined,
                }
              : undefined,
            distribution: distributionData,
            storage: storageStats
              ? {
                  label: `${labels.widgets.storage} · ${storageStats.fileCount}${storageStats.truncated ? "+" : ""} ${labels.widgets.storageMore}`,
                  value: formatBytes(storageStats.totalBytes),
                }
              : undefined,
            database: dbStats
              ? {
                  label: `${labels.widgets.database} · ${labels.widgets.databaseQuota} ${formatBytes(d1Quota)}`,
                  segments: [
                    {
                      id: "used",
                      label: labels.widgets.database,
                      value: dbStats.bytes,
                    },
                  ],
                  total: d1Quota,
                  valueLabel: `${formatBytes(dbStats.bytes)} · ${Math.round((dbStats.bytes / d1Quota) * 100)}%`,
                }
              : null,
          }}
          defaultPresets={{
            activity: "trend-bars",
            distribution: distributionPreset,
            storage: "stat-simple",
            database: "progress-ring",
          }}
          labels={insightsLabels}
        />
      )}
    </div>
  );
}
