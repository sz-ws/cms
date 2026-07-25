"use client";

import Link from "next/link";
import { StatNumber } from "@/components/admin/StatNumber";
import { useT, useLocale } from "@/lib/i18n/I18nProvider";
import { inlineLabel } from "../field-utils";

// Collection 頁首:標題(Paper & Ink 標題級距,非 text-2xl)+ 計數 + 右對齊主要
// 「New」按鈕。計數走 NumberFlow(隨 filter 變動)。

interface CollectionHeaderProps {
  title: string;
  typeLabel: string;
  total: number;
  createHref: string;
}

export function CollectionHeader({
  title,
  typeLabel,
  total,
  createHref,
}: CollectionHeaderProps) {
  const t = useT();
  const locale = useLocale();
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-[20px] font-semibold tracking-[-0.01em] text-black/90">
          {title}
        </h1>
        <p className="text-[12px] text-black/40">
          <StatNumber value={total} className="text-black/55" />
          <span className="pl-1">
            {total === 1 ? t("collection.entry") : t("collection.entries")}
          </span>
        </p>
      </div>
      <Link
        href={createHref}
        className="inline-flex h-10 items-center gap-2 rounded-[8px] bg-black px-4 text-[14px] font-medium text-white transition-[background,transform] active:scale-[0.96] hover:bg-black/85"
      >
        {t("collection.new", { type: inlineLabel(typeLabel, locale) })}
        <span className="text-white/70">→</span>
      </Link>
    </div>
  );
}
