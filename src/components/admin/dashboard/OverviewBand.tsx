import { StatNumber } from "@/components/admin/StatNumber";
import { cn } from "@/lib/utils";
import { SHADOW_RING, ACCENT } from "./styles";
import { StatusDot } from "./StatusDot";

// Task #4 §overview: ONE focal number (total content, large) with the secondary
// stats trailing it inside a single full-width surface — replaces the old row of
// four equal stat cards. Ported from the mock's .w.overview: focal block on the
// left (divider), rest to the right. Published number carries the dither-blue
// accent (the only accent on the band). Counts animate via NumberFlow.

interface OverviewBandProps {
  totalEntries: number;
  totalPublished: number;
  totalDrafts: number;
  typeCount: number;
  userCount: number;
  labels: {
    totalContent: string;
    published: string;
    draft: string;
    drafts: string;
    contentTypes: string;
    users: string;
  };
}

/** One trailing secondary stat: number over a quiet caption. */
function OverviewStat({
  value,
  label,
  accent = false,
}: {
  value: number;
  label: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <div
        className="text-[25px] font-semibold tabular-nums tracking-[-0.02em]"
        style={{ color: accent ? ACCENT : "rgba(0,0,0,0.90)" }}
      >
        <StatNumber value={value} />
      </div>
      <div className="mt-0.5 text-[12.5px] text-black/40">{label}</div>
    </div>
  );
}

export function OverviewBand({
  totalEntries,
  totalPublished,
  totalDrafts,
  typeCount,
  userCount,
  labels,
}: OverviewBandProps) {
  return (
    <section
      className={cn(
        "flex flex-col gap-6 rounded-[16px] bg-white px-6 py-[22px] sm:flex-row sm:flex-wrap sm:items-stretch sm:gap-2",
        SHADOW_RING,
      )}
    >
      {/* Focal block: the one large number for the whole view. */}
      <div className="flex min-w-[170px] flex-col justify-center border-black/[0.08] pb-4 sm:border-b-0 sm:border-r sm:pr-7 sm:pb-0">
        <div className="text-[12.5px] text-black/40">{labels.totalContent}</div>
        <div className="mt-0.5 text-[44px] font-semibold leading-none tabular-nums tracking-[-0.03em] text-black/90">
          <StatNumber value={totalEntries} />
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-[12.5px] text-black/40">
          <StatusDot tone="good" />
          {totalPublished} {labels.published} · {totalDrafts}{" "}
          {totalDrafts === 1 ? labels.draft : labels.drafts}
        </div>
      </div>

      {/* Trailing secondary stats. */}
      <div className="flex flex-wrap items-center gap-x-9 gap-y-4 sm:pl-7">
        <OverviewStat value={totalPublished} label={labels.published} accent />
        <OverviewStat value={typeCount} label={labels.contentTypes} />
        <OverviewStat value={userCount} label={labels.users} />
      </div>
    </section>
  );
}
