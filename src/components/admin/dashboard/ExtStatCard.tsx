import type { ReactNode } from "react";
import { AdminLink } from "@/components/admin/AdminLink";
import { StatNumber } from "@/components/admin/StatNumber";
import { cn } from "@/lib/utils";
import type { Locale } from "@/lib/i18n";
import { ACCENT, SHADOW_RING, SHADOW_RING_HOVER } from "./styles";
import { DeltaPill } from "./widgets/DeltaPill";
import type { Comparison, NumberCardModel } from "./widget-cards";

// roadmap #16 §stat card: extension-contributed number tile. One focal number, the
// card title, and a quiet line under it (the plugin's hint, else the extension's
// name) — the whole card links to the page that handles it. Speaks the same Paper &
// Ink language as ContentTypeCard (white surface, 16px radius, shadow-ring, hover
// lift) so it reads as native next to the core dashboard cards.
//
// 1.62.0: every plugin number goes through here — declarative dashboardCards counts,
// the old dashboardStats and dashboardWidgets of kind "number". The number is written
// for its unit (widget-cards.ts); counts stay the animated StatNumber in the admin
// locale. A number that follows the dashboard's period shows its change against the
// previous period, and a spark draws as a row of small bars. A card without a link
// (only admins see those) drops the hover lift and the "View" line.

interface ExtStatCardProps {
  card: NumberCardModel;
  locale: Locale;
  labels: { view: string };
}

const shell = "flex flex-col gap-3.5 rounded-[calc(16px*var(--admin-radius-scale,1))] bg-surface px-[18px] pt-[18px] pb-4";

function ComparisonLine({ comparison }: { comparison: Comparison }) {
  if (!comparison) return null;
  if (comparison.kind === "delta") return <DeltaPill delta={comparison.delta} unit="%" />;
  return <span className="text-[12px] text-ink/40">{comparison.text}</span>;
}

function Spark({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  return (
    <div aria-hidden className="flex h-6 w-full items-end gap-[2px]">
      {values.map((value, i) => (
        <div
          key={i}
          className="flex-1 rounded-[calc(2px*var(--admin-radius-scale,1))]"
          style={{ height: `${Math.max((value / max) * 100, 6)}%`, backgroundColor: ACCENT, opacity: i === values.length - 1 ? 1 : 0.35 }}
        />
      ))}
    </div>
  );
}

function Body({ card, locale }: Pick<ExtStatCardProps, "card" | "locale">) {
  return (
    <>
      {/* Title + the plugin's hint, else the owning extension. */}
      <div className="flex flex-col gap-px">
        <div className="text-[15px] font-semibold tracking-[-0.01em] text-ink/90">{card.title}</div>
        <div className="text-[12px] text-ink/40">{card.hint}</div>
      </div>

      {/* The one focal number. */}
      <div className="text-[34px] font-semibold leading-[0.9] tabular-nums tracking-[-0.02em] text-ink/90 [overflow-wrap:anywhere]">
        {card.text ?? <StatNumber value={card.value} locales={locale} />}
      </div>
      {card.comparison && (
        <div className="-mt-1">
          <ComparisonLine comparison={card.comparison} />
        </div>
      )}
      {card.spark && card.spark.length > 1 && <Spark values={card.spark} />}
    </>
  );
}

export function ExtStatCard({ card, locale, labels }: ExtStatCardProps): ReactNode {
  if (!card.href) {
    return (
      <div className={cn(shell, SHADOW_RING)}>
        <Body card={card} locale={locale} />
      </div>
    );
  }
  return (
    <AdminLink
      href={card.href}
      className={cn(shell, "group transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-0.5", SHADOW_RING, SHADOW_RING_HOVER)}
    >
      <Body card={card} locale={locale} />

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
