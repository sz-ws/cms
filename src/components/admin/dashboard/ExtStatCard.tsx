import Link from "next/link";
import { StatNumber } from "@/components/admin/StatNumber";
import { cn } from "@/lib/utils";
import type { ResolvedDashboardCard } from "@/ext/dx/dashboard-cards";
import { SHADOW_RING, SHADOW_RING_HOVER } from "./styles";

// roadmap #16 §stat card: extension-contributed count tile. One focal number, the
// card title, and the owning extension as a quiet label — the whole card links to
// the extension's admin surface. Speaks the same Paper & Ink language as
// ContentTypeCard (white surface, 16px radius, shadow-ring, hover lift) so it
// reads as native next to the core dashboard cards.

interface ExtStatCardProps {
  card: ResolvedDashboardCard;
}

export function ExtStatCard({ card }: ExtStatCardProps) {
  return (
    <Link
      href={card.adminHref}
      className={cn(
        "group flex flex-col gap-3.5 rounded-[16px] bg-white px-[18px] pt-[18px] pb-4",
        "transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-0.5",
        SHADOW_RING,
        SHADOW_RING_HOVER,
      )}
    >
      {/* Title + owning extension. */}
      <div className="flex flex-col gap-px">
        <div className="text-[15px] font-semibold tracking-[-0.01em] text-black/90">
          {card.title}
        </div>
        <div className="text-[12px] text-black/40">{card.extName}</div>
      </div>

      {/* The one focal number. */}
      <div className="text-[34px] font-semibold leading-[0.9] tabular-nums tracking-[-0.02em] text-black/90">
        <StatNumber value={card.count ?? 0} />
      </div>

      {/* Affordance — the whole card navigates. */}
      <div className="mt-0.5 flex items-center gap-1 text-[12px] font-medium text-black/45 transition-colors group-hover:text-black/70">
        View all
        <span
          aria-hidden
          className="text-black/30 transition-transform duration-150 ease-out group-hover:translate-x-0.5"
        >
          →
        </span>
      </div>
    </Link>
  );
}
