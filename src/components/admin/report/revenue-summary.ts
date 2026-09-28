// @deprecated 1.62.0 —— 1.61.0 的名字,2.0 拿掉。圖的純函式搬到 components/admin/dashboard/widgets/timeseries.ts,
// 寫期間與比前一段搬到 lib/report-period.ts(periodChange、periodLabel),軸上的短數字是 lib/units.ts 的
// compactNumber。

export {
  axisTickDays,
  dailyRows,
  longDay,
  seriesColor,
  shortDay,
  slotOf,
  type ChartRow,
  type ChartSeries,
} from "../dashboard/widgets/timeseries";
export { periodChange as revenueChange, periodLabel, type PeriodChange as RevenueChange } from "@/lib/report-period";
export { compactNumber as compactAmount } from "@/lib/units";
