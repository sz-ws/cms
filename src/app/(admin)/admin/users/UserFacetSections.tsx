"use client";

import { Fragment, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { AdminLink } from "@/components/admin/AdminLink";
import { cn } from "@/lib/utils";
import type { MemberFacetColumn, UserFacets } from "@/ext/member-facets";

// 成員側欄(UserSheet)的段落標題,以及 1.60.0 插件 facet 的段落(Extension.memberFacets)。
// 一個 facet 一段:標題是 facet 的名稱,內容是插件給的欄位與值(左邊固定寬的名稱欄、
// 值靠左),沒給 lines 時寫 badge;下面是插件的連結。這個人跟某個 facet 無關(沒有值、
// 也沒有連結)時那一段不出現。

export function SheetSectionLabel({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: "danger";
}) {
  return (
    <h3
      className={cn(
        "text-[11px] font-semibold tracking-[0.06em] uppercase",
        tone === "danger" ? "text-red-600/70" : "text-ink/35",
      )}
    >
      {children}
    </h3>
  );
}

export function UserFacetSections({
  facets,
  values,
}: {
  facets: readonly MemberFacetColumn[];
  values: UserFacets | undefined;
}) {
  const sections = facets.flatMap((facet) => {
    const entry = values?.[facet.key];
    return entry ? [{ facet, entry }] : [];
  });
  if (sections.length === 0) return null;
  return (
    <>
      {sections.map(({ facet, entry }) => (
        <div key={facet.key} className="flex flex-col gap-3">
          <SheetSectionLabel>{facet.label}</SheetSectionLabel>
          {entry.value && entry.value.lines.length > 0 ? (
            <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
              {entry.value.lines.map((line, index) => (
                <Fragment key={index}>
                  <dt className="text-ink/45">{line.label}</dt>
                  <dd className="break-words text-ink/80">{line.value}</dd>
                </Fragment>
              ))}
            </dl>
          ) : entry.value ? (
            <p className="text-[13px] text-ink/80">{entry.value.badge}</p>
          ) : null}
          {entry.actions.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {entry.actions.map((action) => (
                <AdminLink
                  key={`${action.label}\n${action.href}`}
                  href={action.href}
                  className="inline-flex w-fit items-center gap-0.5 text-[12.5px] text-ink/55 underline decoration-ink/20 underline-offset-4 transition-colors hover:text-ink/85 hover:decoration-ink/40"
                >
                  {action.label}
                  <ChevronRight aria-hidden className="size-3.5" />
                </AdminLink>
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
