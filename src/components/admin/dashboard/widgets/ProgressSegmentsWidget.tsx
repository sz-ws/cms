import { ACCENT } from "../styles";
import { WidgetShell, WidgetHeader } from "./WidgetShell";
import type { ProportionWidgetData } from "./types";

const SEGMENT_COUNT = 8;

// 佔比家族 · progress-segments——elaborated from watermelon widget-2(Storage
// widget)。原版是 icon + title + subtitle + button 四段式;這裡收斂成跟其他
// preset 一致的 WidgetShell 外殼(呼叫端要按鈕自己疊 action prop,不內建)。
export function ProgressSegmentsWidget({
  data,
}: {
  data: ProportionWidgetData;
}) {
  const used = data.segments[0]?.value ?? 0;
  const total = data.total ?? used;
  const ratio = total > 0 ? Math.min(Math.max(used / total, 0), 1) : 0;

  return (
    <WidgetShell>
      <WidgetHeader label={data.label} />
      <div className="flex flex-1 flex-col justify-center gap-3">
        {data.valueLabel && (
          <span className="text-[26px] font-semibold tracking-[-0.02em] tabular-nums text-black/85">
            {data.valueLabel}
          </span>
        )}
        <div className="flex h-[7px] w-full gap-1">
          {Array.from({ length: SEGMENT_COUNT }).map((_, i) => {
            const fill = Math.min(Math.max(ratio * SEGMENT_COUNT - i, 0), 1);
            return (
              <div
                key={i}
                className="relative flex-1 overflow-hidden rounded-full bg-black/[0.05]"
              >
                <div
                  className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out"
                  style={{ width: `${fill * 100}%`, backgroundColor: ACCENT }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </WidgetShell>
  );
}
