"use client";

"use client";

import { TextMorph } from "torph/react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";

// Status pill for collection rows. The status word (draft ⇄ published) swaps in
// place, so it animates via torph per the project motion policy. torph honours
// prefers-reduced-motion when respectReducedMotion is set.

interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const t = useT();
  const isPublished = status === "published";
  // status 本身(published/draft)是內部值,不是顯示字串——顯示走 i18n;非預期值
  // (理論上不會發生,provider 只寫 draft/published)原樣顯示,不吞掉資訊。
  const label =
    status === "published"
      ? t("collection.status.published")
      : status === "draft"
        ? t("collection.status.draft")
        : status;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium transition-colors duration-150 ease-out",
        isPublished
          ? "bg-chart-2/15 text-chart-2"
          : "bg-muted text-muted-foreground",
      )}
    >
      <TextMorph respectReducedMotion>{label}</TextMorph>
    </span>
  );
}
