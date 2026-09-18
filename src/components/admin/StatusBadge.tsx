"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOptionalT } from "@/lib/i18n/I18nProvider";
import {
  STATUS_TONE_CLASS,
  resolveStatusSet,
  type ResolvedStatus,
  type ResolvedStatusSets,
  type StatusSetDecl,
} from "@/ext/record-status";

// 1.40.0:紀錄狀態的徽章(規則見 ext/record-status.ts)。
//
// 狀態名稱照常顯示;有描述時(站台補的狀態說明,或這一筆在這個狀態下的描述)後面多一個
// 小圖示,滑上去或 Tab 到它看內容。這一筆有自己的描述時圖示用主色,掃一眼就知道
// 哪幾筆被人標過。描述只在後台 —— 前台(會員查單)沒有 provider,只顯示名稱。

const StatusSetsContext = createContext<ResolvedStatusSets | null>(null);

export function StatusSetsProvider({ sets, children }: { sets: ResolvedStatusSets; children: ReactNode }) {
  return <StatusSetsContext.Provider value={sets}>{children}</StatusSetsContext.Provider>;
}

/** 後台給 filter:statusSets 解析過的組;前台(沒有 provider)用插件自己的宣告。 */
export function useStatusSet(ref: string, fallback?: StatusSetDecl): Record<string, ResolvedStatus> {
  const sets = useContext(StatusSetsContext);
  return useMemo(
    () =>
      sets?.[ref] ??
      (fallback
        ? resolveStatusSet(fallback, (label) =>
            typeof label === "string" ? label : (label["zh-Hant"] ?? label.en),
          )
        : {}),
    [sets, ref, fallback],
  );
}

const PILL = "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap";

export function StatusBadge({
  set,
  status,
  note,
  fallback,
  label,
  className,
}: {
  /** 狀態組 `<extId>:<setId>`。 */
  set: string;
  status: string;
  /** 這一筆在這個狀態下的描述(lib/record-status-notes.ts)。 */
  note?: string | null;
  /** 前台或舊 core 用的宣告(沒有 provider 時)。 */
  fallback?: StatusSetDecl;
  /** 覆寫顯示文字(例如「處理中」這種暫時狀態),色調仍取 status 的。 */
  label?: string;
  className?: string;
}) {
  const statuses = useStatusSet(set, fallback);
  // 描述只在後台出現,那裡一定有 I18nProvider;前台沒有 provider 也沒有描述。
  const t = useOptionalT();
  const def = statuses[status] ?? { label: status, tone: "neutral" as const };
  const hasNote = Boolean(note?.trim());
  const described = t !== null && (Boolean(def.addon) || hasNote);

  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span className={cn(PILL, STATUS_TONE_CLASS[def.tone])}>{label ?? def.label}</span>
      {described ? (
        <Tooltip>
          <TooltipTrigger
            aria-label={t?.("status.describe", { status: def.label })}
            // 在可點的列裡:只看說明,不打開整列。
            onClick={(event) => event.stopPropagation()}
            className={cn(
              "inline-flex size-4 items-center justify-center rounded-full outline-none",
              "transition-colors duration-150 focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--admin-accent)_35%,transparent)]",
              hasNote ? "text-(--admin-accent)" : "text-black/30 hover:text-black/60",
            )}
          >
            <Info aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent className="flex max-w-72 flex-col items-start gap-1.5 py-2 text-left leading-relaxed">
            {def.addon ? (
              <span className="flex gap-2">
                <span className="shrink-0 opacity-60">{def.label}</span>
                <span>{def.addon}</span>
              </span>
            ) : null}
            {hasNote ? (
              <span className="flex gap-2">
                <span className="shrink-0 opacity-60">{t?.("status.recordNote")}</span>
                <span>{note}</span>
              </span>
            ) : null}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}
