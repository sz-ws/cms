import { ACCENT } from "../styles";
import { WidgetShell } from "./WidgetShell";
import type { ProportionWidgetData } from "./types";

const STROKE = 9;

/**
 * 環形進度 —— 佔比家族的 bare 版本(無 WidgetShell 外殼),讓其他地方可以把
 * 它嵌進自己的版面(template 化:widget 的視覺不綁死在獨立卡片形狀裡)。
 * ContentTypeCard 用它取代原本的裝飾性 motif band,即一例。
 */
export function ProgressRing({
  value,
  total,
  size = 96,
  centerLabel,
}: {
  value: number;
  total: number;
  size?: number;
  /** 環中央文字;缺省 = 百分比。 */
  centerLabel?: string;
}) {
  const radius = (size - STROKE) / 2;
  const circ = 2 * Math.PI * radius;
  const ratio = total > 0 ? Math.min(Math.max(value / total, 0), 1) : 0;
  const offset = circ * (1 - ratio);
  const percent = Math.round(ratio * 100);

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(0,0,0,0.06)"
          strokeWidth={STROKE}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={ACCENT}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-700 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className="font-semibold tabular-nums leading-none text-black/85"
          style={{ fontSize: size >= 90 ? 22 : 15 }}
        >
          {centerLabel ?? `${percent}%`}
        </span>
      </div>
    </div>
  );
}

// 佔比家族 · progress-ring——單一比例(用量/總量)的環形呈現;新變體(seed widget
// 沒有這款),補齊 progress-segments 之外「更緊湊、單指標」的畫法,適合側邊欄
// 或密集網格。segments[0] 對 total 的比例決定環的填充量。獨立卡片版本
// (registry 用這個);嵌入其他版面請直接用上面的 bare ProgressRing。
export function ProgressRingWidget({ data }: { data: ProportionWidgetData }) {
  const used = data.segments[0]?.value ?? 0;
  const total = data.total ?? used;

  return (
    <WidgetShell className="items-center">
      <span className="self-start text-[13px] font-medium text-black/50">
        {data.label}
      </span>
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <ProgressRing value={used} total={total} />
        {data.valueLabel && (
          <span className="text-[12px] text-black/40">{data.valueLabel}</span>
        )}
      </div>
    </WidgetShell>
  );
}
