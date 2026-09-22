import { AdminLink } from "@/components/admin/AdminLink";
import { cn } from "@/lib/utils";
import type { RecentEntry } from "./aggregate";
import type { Locale } from "@/lib/i18n";
import { relativeTime } from "./relative-time";
import { SHADOW_RING } from "./styles";
import { RingDot } from "./RingDot";
import { StatusDot } from "./StatusDot";
import { StackedList, StackedListItem } from "@/components/ui/stacked-list";

// Task #4 §recent: full-width recent-activity card. Newest-updated entries merged
// across every content type. Each row (mock's .rrow): ring-dot status + title +
// type + status word + relative time. No mono anywhere — sentence-case sans, the
// relative time is tabular-nums but not monospaced. Rows are hairline-separated,
// full-bleed to the card edge.

interface RecentEntriesProps {
  entries: RecentEntry[];
  now: number; // passed from the page so server render is deterministic
  locale: Locale;
  /** 站台時區(1.41.0,lib/datetime-server.ts)。 */
  timeZone?: string;
  labels: {
    title: string;
    subtitle: string;
    empty: string;
    published: string;
    draft: string;
  };
}

export function RecentEntries({ entries, now, locale, timeZone, labels }: RecentEntriesProps) {
  return (
    <section className={cn("flex flex-col rounded-[calc(16px*var(--admin-radius-scale,1))] bg-surface", SHADOW_RING)}>
      <header className="flex flex-col gap-px px-[18px] pt-[18px] pb-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink/90">
          {labels.title}
        </h2>
        <p className="text-[12px] text-ink/40">{labels.subtitle}</p>
      </header>

      {entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-5 pt-2 pb-8 text-center">
          <RingDot />
          <p className="text-[12px] text-ink/45">
            {labels.empty}
          </p>
        </div>
      ) : (
        <StackedList>
          {entries.map((e) => (
            <StackedListItem key={e.id}>
              <AdminLink
                href={e.editHref}
                className={cn(
                  "flex items-center gap-3 border-t border-ink/[0.08] px-[18px] py-[11px]",
                  "transition-colors duration-150 ease-out hover:bg-ink/[0.02]",
                )}
              >
                <StatusDot tone={e.status === "published" ? "good" : "draft"} />
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink/85">
                  {e.title}
                </span>
                <span className="hidden w-[90px] shrink-0 text-[12px] text-ink/40 sm:inline">
                  {e.typeLabel}
                </span>
                <span className="hidden w-[96px] shrink-0 text-[12px] text-ink/55 sm:inline">
                  {e.status === "published" ? labels.published : labels.draft}
                </span>
                <span className="w-14 shrink-0 text-right text-[12px] tabular-nums text-ink/35">
                  {relativeTime(e.updatedAt, now, locale, timeZone)}
                </span>
              </AdminLink>
            </StackedListItem>
          ))}
        </StackedList>
      )}
    </section>
  );
}
