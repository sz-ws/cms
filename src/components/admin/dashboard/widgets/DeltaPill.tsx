import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { TrendWidgetData } from "./types";

const TONE = {
  up: { bg: "bg-[rgba(16,145,90,0.10)]", fg: "text-[rgb(18,124,88)]", Icon: TrendingUp },
  down: { bg: "bg-red-600/10", fg: "text-red-700", Icon: TrendingDown },
  flat: { bg: "bg-black/[0.05]", fg: "text-black/45", Icon: Minus },
} as const;

// 趨勢家族共用的漲跌 pill——琢瑯綠/紅沿用 registry requires chips 的既有色階
// (RegistryBrowser 的 serviceProvided/serviceMissing),不是這裡新發明的顏色。
export function DeltaPill({ delta }: { delta: NonNullable<TrendWidgetData["delta"]> }) {
  const { bg, fg, Icon } = TONE[delta.direction];
  const sign = delta.direction === "up" ? "+" : delta.direction === "down" ? "" : "";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold ${bg} ${fg}`}
    >
      <Icon className="size-3" strokeWidth={2.5} />
      {sign}
      {delta.value}
      {delta.caption && (
        <span className="ml-0.5 font-normal opacity-70">{delta.caption}</span>
      )}
    </span>
  );
}
