"use client";

import { useEffect, useState } from "react";
import {
  resolveRelationOptions,
  type RelationOption,
} from "../../fields/relation-options";

// 08 §2: collection-table cell for relation / relations values. The stored
// value is entry id(s); this client cell resolves them to human titles via the
// target type's /options endpoint (one BATCHED ?ids= fetch per cell).
//
// N+1 CAVEAT: rendered once per row, so a table of N rows fires up to N option
// fetches (each itself batched across that row's ids). Acceptable for v1 admin
// listing sizes (perPage cap 100, options cap 20); a shared per-page resolver
// (one fetch for the whole column) is the documented follow-up. Ids that don't
// resolve fall back to showing the raw id. No synchronous setState in the
// effect — writes happen only inside the async `.then`.

const MAX_CHIPS = 3;

const EMPTY = <span className="text-black/25">—</span>;

function useResolvedTitles(to: string, ids: readonly string[]) {
  const [titles, setTitles] = useState<Record<string, string>>({});
  const idsKey = ids.join(",");
  useEffect(() => {
    if (ids.length === 0) return;
    let active = true;
    const controller = new AbortController();
    void resolveRelationOptions(to, ids, controller.signal).then(
      (opts: RelationOption[]) => {
        if (!active) return;
        setTitles(() => {
          const next: Record<string, string> = {};
          for (const id of ids) {
            next[id] = opts.find((o) => o.id === id)?.title ?? id;
          }
          return next;
        });
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, to]);
  return titles;
}

function TitlePill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex max-w-[14rem] items-center truncate rounded-[6px] bg-black/[0.04] px-1.5 py-0.5 text-[12px] text-black/70">
      {children}
    </span>
  );
}

export function RelationCell({
  to,
  ids,
}: {
  to: string;
  ids: readonly string[];
}) {
  const titles = useResolvedTitles(to, ids);
  if (ids.length === 0) return EMPTY;
  const shown = ids.slice(0, MAX_CHIPS);
  const extra = ids.length - shown.length;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {shown.map((id) => (
        <TitlePill key={id}>{titles[id] ?? id}</TitlePill>
      ))}
      {extra > 0 && (
        <span className="text-[12px] text-black/35 tabular-nums">
          +{extra}
        </span>
      )}
    </span>
  );
}
