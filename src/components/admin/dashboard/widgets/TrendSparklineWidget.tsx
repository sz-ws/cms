import { StatNumber } from "@/components/admin/StatNumber";
import { ACCENT } from "../styles";
import { WidgetShell, WidgetHeader } from "./WidgetShell";
import { DeltaPill } from "./DeltaPill";
import type { TrendWidgetData } from "./types";

const W = 240;
const H = 44;

function toPath(series: number[]): { line: string; area: string } {
  if (series.length < 2) return { line: "", area: "" };
  const max = Math.max(...series);
  const min = Math.min(...series);
  const range = max - min || 1;
  const step = W / (series.length - 1);
  const points = series.map((v, i) => {
    const x = i * step;
    const y = H - ((v - min) / range) * H;
    return [x, y] as const;
  });
  const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  return { line, area };
}

// 趨勢家族 · trend-sparkline——新變體(seed widget 沒有這款)。trend-bars 的
// 長條在筆數多(如 30 天)時會擠成鋸齒;這是同一份 series[] 換一種畫法,平滑
// 線條 + 面積填色,對長序列更好讀。手捲 SVG polyline,不吃 recharts(這個
// preset 夠簡單,不值得多一份 chart-lib render 成本)。
export function TrendSparklineWidget({ data }: { data: TrendWidgetData }) {
  const series = data.series ?? [];
  const { line, area } = toPath(series);

  return (
    <WidgetShell>
      <WidgetHeader label={data.label} />
      <div className="flex flex-1 flex-col justify-between gap-3">
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
        {line && (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="h-11 w-full"
          >
            <defs>
              <linearGradient id="sparkline-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={ACCENT} stopOpacity={0.18} />
                <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
              </linearGradient>
            </defs>
            <path d={area} fill="url(#sparkline-fill)" stroke="none" />
            <path
              d={line}
              fill="none"
              stroke={ACCENT}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
      </div>
    </WidgetShell>
  );
}
