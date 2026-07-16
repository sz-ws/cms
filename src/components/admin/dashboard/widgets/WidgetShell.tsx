import { cn } from "@/lib/utils";
import { SHADOW_RING } from "../styles";

// 七款 preset 共用外殼:rounded-[16px] 白底 + shadow-ring(同 ContentTypeCard /
// OverviewBand 語言),讓整組 widget 家族跟核心卡片視覺上是同一套系統,不是外掛。
export function WidgetShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-full flex-col gap-4 rounded-[16px] bg-white px-5 py-[18px]",
        SHADOW_RING,
        className,
      )}
    >
      {children}
    </div>
  );
}

export function WidgetHeader({
  label,
  action,
}: {
  label: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-[13px] font-medium text-black/50">{label}</span>
      {action}
    </div>
  );
}
