import { cn } from "@/lib/utils";

// The house ring-dot status mark, in two tones (mock's .dot.good / .dot.draft):
//   good  → muted green ring + green dot   (published)
//   draft → ink ring + ink dot             (draft / unpublished)
// Same size-3-ring / size-1-dot geometry as RingDot; this variant carries the
// published-vs-draft colour so per-type splits and the recent-activity rows read
// their status at a glance. Reused across the split, overview sub, and rows.

const GOOD_RING = "rgba(63,154,107,0.55)";
const GOOD_DOT = "#3f9a6b";
const DRAFT_RING = "rgba(0,0,0,0.28)";
const DRAFT_DOT = "rgba(0,0,0,0.28)";

interface StatusDotProps {
  tone: "good" | "draft";
  className?: string;
}

export function StatusDot({ tone, className }: StatusDotProps) {
  const good = tone === "good";
  return (
    <span
      className={cn(
        "relative inline-flex size-[11px] items-center justify-center rounded-full",
        className,
      )}
      style={{ boxShadow: `inset 0 0 0 1.5px ${good ? GOOD_RING : DRAFT_RING}` }}
      aria-hidden
    >
      <span
        className="size-1 rounded-full"
        style={{ backgroundColor: good ? GOOD_DOT : DRAFT_DOT }}
      />
    </span>
  );
}
