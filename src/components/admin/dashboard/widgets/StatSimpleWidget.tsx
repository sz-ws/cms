import { StatNumber } from "@/components/admin/StatNumber";
import { WidgetShell } from "./WidgetShell";
import { DeltaPill } from "./DeltaPill";
import type { TrendWidgetData } from "./types";

// 趨勢家族 · stat-simple——新變體(seed widget 沒有這款)。當沒有值得畫的
// series(單一計數器場景),trend-bars/sparkline 的圖表位置會空著很尷尬;
// 這款直接不留圖表位置,大字 + delta 就是全部內容。
export function StatSimpleWidget({ data }: { data: TrendWidgetData }) {
  return (
    <WidgetShell className="justify-center">
      <span className="text-[13px] font-medium text-black/50">
        {data.label}
      </span>
      <div className="flex items-end gap-2.5">
        <span className="text-[36px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-black/85">
          {typeof data.value === "number" ? (
            <StatNumber value={data.value} />
          ) : (
            data.value
          )}
        </span>
        {data.delta && <DeltaPill delta={data.delta} />}
      </div>
    </WidgetShell>
  );
}
