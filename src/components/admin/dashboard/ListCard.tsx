import { AdminLink } from "@/components/admin/AdminLink";
import { StackedList, StackedListItem } from "@/components/ui/stacked-list";
import { cn } from "@/lib/utils";
import type { Locale } from "@/lib/i18n";
import { relativeTime } from "./relative-time";
import { RingDot } from "./RingDot";
import { SHADOW_RING } from "./styles";
import type { ListCardModel } from "./widget-cards";

// 1.62.0:插件的 list 卡(dashboardWidgets 的 kind "list")。跟宣告式的「最近更新」卡(ExtRecentCard)
// 同一個樣子:標題與小字、「查看全部」連到 href、一列一筆(有 href 的整列連過去)、右邊是多久以前。

interface ListCardProps {
  card: ListCardModel;
  now: number;
  locale: Locale;
  timeZone: string;
  labels: { viewAll: string; empty: string };
}

const row = "flex items-center gap-3 border-t border-ink/[0.08] px-[18px] py-[10px]";

export function ListCard({ card, now, locale, timeZone, labels }: ListCardProps) {
  return (
    <section className={cn("flex flex-col rounded-[calc(16px*var(--admin-radius-scale,1))] bg-surface", SHADOW_RING)}>
      <header className="flex items-end justify-between gap-3 px-[18px] pt-[18px] pb-3">
        <div className="flex flex-col gap-px">
          <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-ink/90">{card.title}</h3>
          <p className="text-[12px] text-ink/40">{card.hint}</p>
        </div>
        {card.href && (
          <AdminLink href={card.href} className="shrink-0 text-[12px] font-medium text-ink/45 transition-colors duration-150 ease-out hover:text-ink/75">
            {labels.viewAll}
          </AdminLink>
        )}
      </header>

      {card.items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-5 pt-1 pb-7 text-center">
          <RingDot />
          <p className="text-[12px] text-ink/45">{labels.empty}</p>
        </div>
      ) : (
        <StackedList>
          {card.items.map((item) => {
            const content = (
              <>
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink/85">{item.title}</span>
                {item.at !== undefined && (
                  <span className="shrink-0 text-right text-[12px] tabular-nums text-ink/35">{relativeTime(item.at, now, locale, timeZone)}</span>
                )}
              </>
            );
            return (
              <StackedListItem key={item.id}>
                {item.href ? (
                  <AdminLink href={item.href} className={cn(row, "transition-colors duration-150 ease-out hover:bg-ink/[0.02]")}>
                    {content}
                  </AdminLink>
                ) : (
                  <div className={row}>{content}</div>
                )}
              </StackedListItem>
            );
          })}
        </StackedList>
      )}
    </section>
  );
}
