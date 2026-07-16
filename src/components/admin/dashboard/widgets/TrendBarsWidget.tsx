import { StatNumber } from "@/components/admin/StatNumber";
import { ACCENT } from "../styles";
import { WidgetShell, WidgetHeader } from "./WidgetShell";
import { DeltaPill } from "./DeltaPill";
import type { TrendWidgetData } from "./types";

// 趨勢家族 · trend-bars——elaborated from watermelon widget-6(Weekly
// engagement)。原版用固定 32 根、entrance keyframe 動畫的長條;這裡改吃真實
// series[](長度不限,通常是每日/每週一格),拿掉進場動畫換成單純的
// transition-[height](server component 語境下,keyframe entrance 需要額外
// client mounted-flag 才不會在 SSR/hydration 間閃爍,划不來)。最後一格加亮
// 標記「當下」。
export function TrendBarsWidget({ data }: { data: TrendWidgetData }) {
  const series = data.series ?? [];
  const max = Math.max(...series, 1);

  return (
    <WidgetShell>
      <WidgetHeader label={data.label} />
      <div className="flex flex-1 flex-col justify-between gap-4">
        <div className="flex items-end justify-between gap-2">
          <span className="text-[32px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-black/85">
            {typeof data.value === "number" ? (
              <StatNumber value={data.value} />
            ) : (
              data.value
            )}
          </span>
          {data.delta && <DeltaPill delta={data.delta} />}
        </div>
        {series.length > 0 && (
          <div className="flex h-10 w-full items-end gap-[3px]">
            {series.map((v, i) => (
              <div
                key={i}
                className="flex-1 origin-bottom rounded-[2px] transition-[height] duration-500 ease-out"
                style={{
                  height: `${Math.max((v / max) * 100, 6)}%`,
                  backgroundColor: ACCENT,
                  opacity: i === series.length - 1 ? 1 : 0.35,
                }}
              />
            ))}
          </div>
        )}
      </div>
    </WidgetShell>
  );
}
