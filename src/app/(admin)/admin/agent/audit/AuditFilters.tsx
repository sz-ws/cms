"use client";

import Link from "next/link";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n";
import { auditHref, type AuditView } from "./audit-filter";

// 篩選列:四個互斥的視角 + 可拆的 tool chip。全部是連結 —— 換篩選 = 換 URL,
// 這一層沒有自己的狀態(見 audit-filter.ts 檔頭)。
//
// 視角的順序照「多 → 少」:全部、查詢(大宗)、變更(要盯的)、失敗(要修的)。
// 選中態用白底 + hairline ring(同 sidebar 的作用中項),不用實色填滿 ——
// 這是篩選,不是導覽的主角。

const VIEWS: { view: AuditView; label: MessageKey }[] = [
  { view: "all", label: "agent.audit.filter.all" },
  { view: "read", label: "agent.audit.filter.read" },
  { view: "write", label: "agent.audit.filter.write" },
  { view: "failed", label: "agent.audit.filter.failed" },
];

interface AuditFiltersProps {
  view: AuditView;
  tool: string | null;
}

export function AuditFilters({ view, tool }: AuditFiltersProps) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <nav aria-label={t("agent.audit.filter.all")} className="flex items-center gap-1">
        {VIEWS.map((v) => {
          const active = v.view === view;
          return (
            <Link
              key={v.view}
              href={auditHref({ view: v.view, tool })}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex h-7 items-center rounded-[7px] px-2.5 text-[12.5px] font-medium transition-[color,background-color,box-shadow] duration-150",
                active
                  ? "bg-white text-black/85 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06)]"
                  : "text-black/45 hover:bg-black/[0.03] hover:text-black/75",
              )}
            >
              {t(v.label)}
            </Link>
          );
        })}
      </nav>
      {tool && (
        <Link
          href={auditHref({ view, tool: null })}
          aria-label={t("agent.audit.filter.clearTool")}
          title={t("agent.audit.filter.clearTool")}
          className="ml-1 inline-flex h-7 items-center gap-1.5 rounded-[7px] bg-black/[0.045] pr-1.5 pl-2.5 font-mono text-[11px] lowercase text-black/60 transition-colors duration-150 hover:bg-black/[0.07] hover:text-black/85"
        >
          {tool}
          <X className="size-3 text-black/40" />
        </Link>
      )}
    </div>
  );
}
