import Link from "next/link";
import { cn } from "@/lib/utils";
import type { ResolvedDashboardCard } from "@/ext/dx/dashboard-cards";
import type { Locale } from "@/lib/i18n";
import { relativeTime } from "./relative-time";
import { SHADOW_RING } from "./styles";
import { StatusDot } from "./StatusDot";
import { RingDot } from "./RingDot";
import { StackedList, StackedListItem } from "@/components/ui/stacked-list";

// roadmap #16 §recent card: extension-contributed feed of the newest-updated
// entries of one content type. Structure + status mark mirror the core
// RecentEntries card (ring-dot status, hairline-separated rows, relative time) so
// it reads as native. Each row links into that entry's admin edit page; the
// header carries a "View all" link to the extension's admin surface.

interface ExtRecentCardProps {
  card: ResolvedDashboardCard;
  now: number; // passed from the page so server render is deterministic
  locale: Locale;
  labels: {
    viewAll: string;
    empty: string;
    published: string;
    draft: string;
  };
}

export function ExtRecentCard({ card, now, locale, labels }: ExtRecentCardProps) {
  const entries = card.entries ?? [];
  return (
    <section className={cn("flex flex-col rounded-[16px] bg-white", SHADOW_RING)}>
      <header className="flex items-end justify-between gap-3 px-[18px] pt-[18px] pb-3">
        <div className="flex flex-col gap-px">
          <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-black/90">
            {card.title}
          </h3>
          <p className="text-[12px] text-black/40">{card.extName}</p>
        </div>
        <Link
          href={card.adminHref}
          className="shrink-0 text-[12px] font-medium text-black/45 transition-colors duration-150 ease-out hover:text-black/75"
        >
          {labels.viewAll}
        </Link>
      </header>

      {entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-5 pt-1 pb-7 text-center">
          <RingDot />
          <p className="text-[12px] text-black/45">{labels.empty}</p>
        </div>
      ) : (
        <StackedList>
          {entries.map((e) => (
            <StackedListItem key={e.id}>
              <Link
                href={e.editHref}
                className={cn(
                  "flex items-center gap-3 border-t border-black/[0.08] px-[18px] py-[10px]",
                  "transition-colors duration-150 ease-out hover:bg-black/[0.02]",
                )}
              >
                <StatusDot tone={e.status === "published" ? "good" : "draft"} />
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-black/85">
                  {e.title}
                </span>
                <span className="hidden w-[88px] shrink-0 text-[12px] text-black/55 sm:inline">
                  {e.status === "published" ? labels.published : labels.draft}
                </span>
                <span className="w-14 shrink-0 text-right text-[12px] tabular-nums text-black/35">
                  {relativeTime(e.updatedAt, now, locale)}
                </span>
              </Link>
            </StackedListItem>
          ))}
        </StackedList>
      )}
    </section>
  );
}
