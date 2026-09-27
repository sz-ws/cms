"use client";

import { Check } from "lucide-react";
import { useT } from "@/lib/i18n/I18nProvider";
import { cn } from "@/lib/utils";
import { detailParagraphs } from "./store-filter";
import type { RegistryEntry } from "./registry-types";

// 1.58.0:詳情頁的「關於」:簡介、幾句重點、較長的說明。全部是純文字(React 跳脫),
// index route 已挑好語系。三者都沒有就整段不畫。

export function StoreAbout({ entry, className }: { entry: RegistryEntry; className?: string }) {
  const t = useT();
  const highlights = entry.highlights ?? [];
  const paragraphs = detailParagraphs(entry.details);
  if (!entry.description && highlights.length === 0 && paragraphs.length === 0) return null;

  return (
    <section className={className}>
      <h2 className="mb-2.5 text-[15px] font-semibold tracking-[-0.01em] text-ink/85">
        {t("registryBrowser.detail.about")}
      </h2>
      {entry.description && (
        <p className="text-pretty text-[15px] leading-relaxed text-ink/75">{entry.description}</p>
      )}
      {highlights.length > 0 && (
        <ul className={cn("flex flex-col gap-2.5", entry.description && "mt-4")}>
          {highlights.map((line, i) => (
            <li key={i} className="flex gap-2.5 text-[14px] leading-snug text-ink/75">
              <Check className="mt-px size-4 shrink-0 text-(--admin-accent)" strokeWidth={2.25} aria-hidden />
              <span className="min-w-0 break-words">{line}</span>
            </li>
          ))}
        </ul>
      )}
      {paragraphs.length > 0 && (
        <div
          className={cn(
            "flex flex-col gap-3",
            (entry.description || highlights.length > 0) && "mt-5 border-t border-ink/[0.06] pt-5",
          )}
        >
          {paragraphs.map((paragraph, i) => (
            <p key={i} className="text-pretty break-words text-[14px] leading-[1.75] text-ink/60">
              {paragraph}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
