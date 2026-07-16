import { StatNumber } from "@/components/admin/StatNumber";
import { WidgetShell, WidgetHeader } from "./WidgetShell";
import { segmentColor } from "./palette";
import type { ProportionWidgetData } from "./types";

// 佔比家族 · bar-list——donut 在段落數多時會失去可讀性(切片太細分不出色階),
// 這是它的解法:排序後的橫向長條清單,寬度按最大值正規化,不受段落數限制。
// 新變體(seed widget 沒有這款),補齊「多段落佔比」這個 donut 顧不到的場景。
export function BarListWidget({ data }: { data: ProportionWidgetData }) {
  const sorted = [...data.segments].sort((a, b) => b.value - a.value);
  const max = Math.max(...sorted.map((s) => s.value), 1);

  return (
    <WidgetShell>
      <WidgetHeader label={data.label} />
      <div className="flex flex-1 flex-col justify-center gap-2.5">
        {sorted.map((s, i) => (
          <div key={s.id} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[12.5px] text-black/55">
                {s.label}
              </span>
              <span className="shrink-0 text-[12.5px] font-semibold tabular-nums text-black/80">
                <StatNumber value={s.value} />
              </span>
            </div>
            <div className="h-[6px] w-full overflow-hidden rounded-full bg-black/[0.05]">
              <div
                className="h-full rounded-full transition-[width] duration-500 ease-out"
                style={{
                  width: `${Math.max((s.value / max) * 100, 2)}%`,
                  backgroundColor: segmentColor(i),
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </WidgetShell>
  );
}
