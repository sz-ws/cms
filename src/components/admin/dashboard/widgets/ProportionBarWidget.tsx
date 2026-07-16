import { StatNumber } from "@/components/admin/StatNumber";
import { WidgetShell, WidgetHeader } from "./WidgetShell";
import { segmentColor } from "./palette";
import type { ProportionWidgetData } from "./types";

/**
 * 佔比家族 · proportion-bar —— 新變體(seed widget 沒有這款)。donut/ring 都要
 * 一個近似正方的空間;寬版面(hero 卡、橫幅)裡它們會被壓扁或留白。這是同一份
 * segments 換成「橫向堆疊條」:寬度天生吃滿水平空間,兩三段的比例一眼可讀。
 * bare 版本(無外殼)讓 ContentTypeCard 的 hero 直接嵌進自己的版面 —— 呼應
 * bare ProgressRing 的用法(widget 視覺不綁死在獨立卡殼裡)。
 */
export function ProportionBar({
  segments,
  colors,
  height = 12,
  className,
}: {
  segments: { id: string; label: string; value: number }[];
  /** 缺省 = 佔比家族的 dither-blue 色階(palette.ts)。呼叫端可覆寫成語意色
   *  (如 hero 用 accent/ink 區分 已發布/草稿,對比更明確)。 */
  colors?: string[];
  height?: number;
  className?: string;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const color = (i: number) => colors?.[i] ?? segmentColor(i);

  return (
    // 純視覺回聲(精確數字在相鄰的 split 文字裡),對 AT 隱藏,不做未命名 img。
    <div
      className={className}
      style={{ display: "flex", gap: 2, height, width: "100%" }}
      aria-hidden
    >
      {total === 0 ? (
        // 空資料不畫比例(避免畫一條假滿條);留一條中性軌道佔位。
        <div className="h-full w-full rounded-full bg-black/[0.05]" />
      ) : (
        segments.map((s, i) => {
          const pct = (s.value / total) * 100;
          if (pct === 0) return null;
          return (
            <div
              key={s.id}
              className="h-full rounded-full transition-[flex-basis] duration-500 ease-out"
              style={{ flexBasis: `${pct}%`, backgroundColor: color(i) }}
            />
          );
        })
      )}
    </div>
  );
}

// 佔比家族 · proportion-bar 的獨立卡片版本(registry 用這個)。label + 橫向堆疊
// 條 + 內嵌圖例。嵌入其他版面請直接用上面的 bare ProportionBar。
export function ProportionBarWidget({ data }: { data: ProportionWidgetData }) {
  return (
    <WidgetShell>
      <WidgetHeader label={data.label} />
      <div className="flex flex-1 flex-col justify-center gap-3">
        <ProportionBar segments={data.segments} />
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {data.segments.map((s, i) => (
            <div key={s.id} className="flex items-center gap-1.5">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: segmentColor(i) }}
              />
              <span className="text-[12.5px] text-black/55">{s.label}</span>
              <span className="text-[12.5px] font-semibold tabular-nums text-black/80">
                <StatNumber value={s.value} />
              </span>
            </div>
          ))}
        </div>
      </div>
    </WidgetShell>
  );
}
