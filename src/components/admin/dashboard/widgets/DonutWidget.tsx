"use client";

import { PieChart, Pie, Cell, Tooltip } from "recharts";
import { StatNumber } from "@/components/admin/StatNumber";
import { WidgetShell, WidgetHeader } from "./WidgetShell";
import { segmentColor } from "./palette";
import type { ProportionWidgetData } from "./types";

// 佔比家族 · donut——elaborated from watermelon widget-4(Revenue widget)。
// 原版用 shadcn --primary CSS var 硬編;這裡改吃 dither-blue 色階(palette.ts),
// tooltip 換成專案自己的 rounded-[10px] + shadow-ring 語言而非 shadcn 預設。
// 段落數 >5~6 建議改用 bar-list(圓餅圖切太細會失去可讀性)。
export function DonutWidget({ data }: { data: ProportionWidgetData }) {
  const total = data.total ?? data.segments.reduce((s, x) => s + x.value, 0);

  return (
    <WidgetShell>
      <WidgetHeader label={data.label} />
      <div className="flex flex-1 items-center gap-5">
        <div className="relative size-[104px] shrink-0">
          {/* 固定 104px 方框,直接給 PieChart 明確 width/height ——不用
              ResponsiveContainer(它靠 ResizeObserver 量測,SSR/首次渲染量不到
              會丟 "width(-1) height(-1)" console 警告;這裡尺寸本來就是定死的,
              量測反而是多餘的間接層)。 */}
          <PieChart width={104} height={104}>
            <Pie
              data={data.segments}
              cx="50%"
              cy="50%"
              innerRadius="68%"
              outerRadius="100%"
              paddingAngle={3}
              dataKey="value"
              stroke="none"
              cornerRadius={3}
              isAnimationActive={false}
            >
              {data.segments.map((s, i) => (
                <Cell key={s.id} fill={segmentColor(i)} />
              ))}
            </Pie>
            <Tooltip
              cursor={false}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as { label: string; value: number };
                return (
                  <div className="rounded-[10px] bg-white px-3 py-2 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_8px_20px_-8px_rgba(30,20,50,0.18)]">
                    <div className="text-[11px] text-black/40">{p.label}</div>
                    <div className="text-[13px] font-semibold tabular-nums text-black/85">
                      {p.value.toLocaleString()}
                    </div>
                  </div>
                );
              }}
            />
          </PieChart>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[15px] font-semibold tabular-nums text-black/85">
              <StatNumber value={total} />
            </span>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {data.segments.map((s, i) => (
            <div key={s.id} className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: segmentColor(i) }}
                />
                <span className="truncate text-[12.5px] text-black/55">
                  {s.label}
                </span>
              </div>
              <span className="shrink-0 text-[12.5px] font-medium tabular-nums text-black/75">
                {s.value.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </div>
    </WidgetShell>
  );
}
