// Task #7 §2: designed empty state — ring-dot mark, one sentence, one action.
// Mirrors DashboardEmpty.tsx's recipe exactly (shadow-ring card, no illustration
// blob, no kit spinner) but the CTA scrolls to/focuses the upload zone instead
// of navigating away, since the action lives on this same page.

import { useT } from "@/lib/i18n/I18nProvider";

interface MediaEmptyProps {
  filtered: boolean;
  onClearFilter: () => void;
}

export function MediaEmpty({ filtered, onClearFilter }: MediaEmptyProps) {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-4 rounded-[14px] bg-white px-6 py-16 text-center shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]">
      <span className="grid size-3 place-items-center rounded-full ring-1 ring-black/25">
        <span className="size-1 rounded-full bg-black/25" />
      </span>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-black/90">
          {filtered ? t("mediaEmpty.titleFiltered") : t("mediaEmpty.title")}
        </h2>
        <p className="max-w-sm text-[13px] leading-relaxed text-black/45">
          {filtered ? t("mediaEmpty.filteredDesc") : t("mediaEmpty.emptyDesc")}
        </p>
      </div>
      {filtered && (
        <button
          type="button"
          onClick={onClearFilter}
          className="inline-flex h-9 items-center gap-1.5 rounded-[8px] bg-black px-4 text-[13px] font-medium text-white transition-[background-color,transform] duration-150 ease-out hover:bg-black/85 active:scale-[0.96]"
        >
          {t("mediaEmpty.clearFilter")}
        </button>
      )}
    </div>
  );
}
