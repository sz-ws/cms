"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { StatusBadge } from "../StatusBadge";
import { BulkActionBar } from "./BulkActionBar";
import { useT } from "@/lib/i18n/I18nProvider";

// core-v2 §3.5:admin grid renderer(sibling of CollectionTable)。同樣擁有 row
// selection state 並復用 BulkActionBar。每張卡 = cover(image outline + aspect box,
// 無 media 欄則純文字卡)+ title + StatusBadge + meta 行 + 角落 selection checkbox。
// Paper & Ink:白卡、shadow-ring(非實線邊)、concentric radii(14px 卡 / 6px pad →
// 8px 圖)、hover lift(transform/opacity,compositor-friendly)、dither-blue 選取。

export interface GridCard {
  id: string;
  status: string;
  editHref: string;
  title: string;
  /** 封面圖 media key(/api/files/<key>);null 或非圖 → 文字卡。 */
  coverKey: string | null;
  /** meta 行文字(select 值或日期);空字串則不顯示。 */
  meta: string;
}

interface CollectionGridProps {
  extId: string;
  typeName: string;
  cards: GridCard[];
}

const IMAGE_EXTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "avif",
  "svg",
]);

function isImageKey(key: string): boolean {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

/** 角落選取 checkbox。≥40px hit area,不與卡片編輯連結重疊(獨立 stacking)。 */
function CornerCheckbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className="absolute left-1 top-1 z-10 inline-flex size-10 items-center justify-center"
    >
      <span
        className={cn(
          "inline-flex size-5 items-center justify-center rounded-[6px] transition-[background,box-shadow] active:scale-[0.9]",
          checked
            ? "bg-[rgb(86,114,228)] shadow-[0_0_0_1px_rgb(86,114,228)]"
            : "bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.15)] hover:shadow-[0_0_0_1px_rgba(0,0,0,0.3)]",
        )}
      >
        {checked && (
          <svg viewBox="0 0 12 12" className="size-3 text-white" aria-hidden>
            <path
              d="M2.5 6.2l2 2 5-5.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
    </button>
  );
}

function CardCover({ coverKey, title }: { coverKey: string | null; title: string }) {
  if (coverKey && isImageKey(coverKey)) {
    return (
      // 圖走 /api/files/<key> 串流,原生 <img> 即可。image outline = 純黑低透明,
      // 8px 圓角坐落於 14px 卡 - 6px pad 內。aspect box 免 CLS。
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/files/${coverKey}`}
        alt=""
        loading="lazy"
        className="aspect-[4/3] w-full rounded-[8px] object-cover shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)]"
      />
    );
  }
  // 文字卡(無 media 欄或非圖):以首字母占位,維持相同 aspect 讓格線齊整。
  const initial = title.trim().charAt(0).toUpperCase() || "—";
  return (
    <div className="flex aspect-[4/3] w-full items-center justify-center rounded-[8px] bg-black/[0.03] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)]">
      <span className="text-[28px] font-semibold text-black/15">{initial}</span>
    </div>
  );
}

export function CollectionGrid({ extId, typeName, cards }: CollectionGridProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const t = useT();
  const allIds = useMemo(() => cards.map((c) => c.id), [cards]);
  const allSelected = selected.size > 0 && selected.size === cards.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === cards.length ? new Set() : new Set(allIds),
    );
  }

  function clearSelection() {
    setSelected(new Set());
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between px-0.5">
        <button
          type="button"
          onClick={toggleAll}
          className="text-[12px] font-medium text-black/45 transition-colors hover:text-black/70"
        >
          {allSelected
            ? t("collection.deselectAll")
            : t("collection.selectAll")}
        </button>
      </div>

      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {cards.map((card) => {
          const isSel = selected.has(card.id);
          return (
            <li key={card.id} className="group relative">
              <CornerCheckbox
                checked={isSel}
                onChange={() => toggle(card.id)}
                label={`Select ${card.title || card.id}`}
              />
              <Link
                href={card.editHref}
                className={cn(
                  "flex flex-col gap-3 rounded-[14px] bg-white p-1.5 outline-none transition-[transform,box-shadow] duration-150 ease-out",
                  "will-change-transform hover:-translate-y-0.5",
                  isSel
                    ? "shadow-[0_0_0_1px_rgb(86,114,228),0_8px_24px_-8px_rgba(86,114,228,0.35)]"
                    : "shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)] hover:shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_12px_28px_-10px_rgba(30,20,50,0.18)]",
                )}
              >
                <CardCover coverKey={card.coverKey} title={card.title} />
                <div className="flex flex-col gap-2 px-1.5 pb-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="line-clamp-2 text-[14px] font-medium leading-snug text-black/85">
                      {card.title || card.id}
                    </span>
                    <StatusBadge status={card.status} />
                  </div>
                  {card.meta && (
                    <span className="text-[12px] tabular-nums text-black/45">
                      {card.meta}
                    </span>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>

      <BulkActionBar
        extId={extId}
        typeName={typeName}
        ids={[...selected]}
        onDone={clearSelection}
      />
    </div>
  );
}
