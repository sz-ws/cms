import { AdminLink } from "@/components/admin/AdminLink";
import { StatNumber } from "@/components/admin/StatNumber";
import { cn } from "@/lib/utils";
import type { ResolvedDashboardCard } from "@/ext/dx/dashboard-cards";
import type { Locale } from "@/lib/i18n";
import { SHADOW_RING, SHADOW_RING_HOVER } from "./styles";

// roadmap #16 §stat card: extension-contributed count tile. One focal number, the
// card title, and the owning extension as a quiet label — the whole card links to
// the extension's admin surface. Speaks the same Paper & Ink language as
// ContentTypeCard (white surface, 16px radius, shadow-ring, hover lift) so it
// reads as native next to the core dashboard cards.
//
// 1.52.0: the same tile carries a plugin's own number (Extension.dashboardStats):
// its display string when given (money, points with decimals), otherwise the
// number formatted for the admin locale; its hint replaces the extension name.

interface ExtStatCardProps {
  card: ResolvedDashboardCard;
  locale: Locale;
  labels: { view: string };
}

export function ExtStatCard({ card, locale, labels }: ExtStatCardProps) {
  return (
    <AdminLink
      href={card.adminHref}
      className={cn(
        "group flex flex-col gap-3.5 rounded-[calc(16px*var(--admin-radius-scale,1))] bg-surface px-[18px] pt-[18px] pb-4",
        "transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-0.5",
        SHADOW_RING,
        SHADOW_RING_HOVER,
      )}
    >
      {/* Title + the plugin's hint, else the owning extension. */}
      <div className="flex flex-col gap-px">
        <div className="text-[15px] font-semibold tracking-[-0.01em] text-ink/90">
          {card.title}
        </div>
        <div className="text-[12px] text-ink/40">{card.hint ?? card.extName}</div>
      </div>

      {/* The one focal number. */}
      <div className="text-[34px] font-semibold leading-[0.9] tabular-nums tracking-[-0.02em] text-ink/90 [overflow-wrap:anywhere]">
        {card.display ?? <StatNumber value={card.count ?? 0} locales={locale} />}
      </div>

      {/* Affordance — the whole card navigates. */}
      <div className="mt-0.5 flex items-center gap-1 text-[12px] font-medium text-ink/45 transition-colors group-hover:text-ink/70">
        {labels.view}
        <span
          aria-hidden
          className="text-ink/30 transition-transform duration-150 ease-out group-hover:translate-x-0.5"
        >
          →
        </span>
      </div>
    </AdminLink>
  );
}
