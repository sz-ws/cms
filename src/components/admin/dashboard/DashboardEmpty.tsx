import Link from "next/link";
import { cn } from "@/lib/utils";
import { SHADOW_RING } from "./styles";
import { RingDot } from "./RingDot";

// Designed empty state for a fresh install: no declarative content types exist.
// A quiet ring-dot mark, one guiding sentence, one action → the extensions
// browser. No illustration blob, no kit spinner (design language).

interface DashboardEmptyProps {
  labels: {
    title: string;
    desc: string;
    browseExtensions: string;
  };
}

export function DashboardEmpty({ labels }: DashboardEmptyProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-4 rounded-[14px] bg-white px-6 py-16 text-center",
        SHADOW_RING,
      )}
    >
      <RingDot accent className="scale-125" />
      <div className="flex flex-col gap-1.5">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-black/90">
          {labels.title}
        </h2>
        <p className="max-w-sm text-[13px] leading-relaxed text-black/45">
          {labels.desc}
        </p>
      </div>
      <Link
        href="/admin/extensions"
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-[8px] bg-black px-4 text-[13px] font-medium text-white",
          "transition-[background-color,transform] duration-150 ease-out",
          "hover:bg-black/85 active:scale-[0.96]",
        )}
      >
        {labels.browseExtensions}
        <span className="text-white/70">→</span>
      </Link>
    </div>
  );
}
