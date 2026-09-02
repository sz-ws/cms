"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, useLocale } from "@/lib/i18n/I18nProvider";
import { relativeTimeWords } from "@/lib/relative-time";
import { StatusDot } from "@/components/admin/dashboard/StatusDot";
import { toolLeaf, toolNamespace } from "@/components/admin/agent/tools";
import type { AgentAuditRow } from "@/ext/agent-audit";
import { auditHref, type AuditView } from "./audit-filter";

// 稽核列表。視覺沿用面板內的 ToolCallsSection(同一種資料,同一種讀法):白底
// rounded-[12px] 容器、每列一個 ring-dot、tool 名 mono 兩段色、失敗紅字。
// 這裡多了三樣面板沒有的東西 —— 誰(email)、什麼時候、以及展開後的
// args / result / error 全文(截斷版,上限見 src/ext/agent-audit.ts)。
//
// 展開是純條件渲染,不動 height(layout-bound 屬性,規則明列不動它)。
// 一次只展開一列不是限制,是沒必要:稽核是逐列讀的。

interface AuditLogProps {
  rows: AgentAuditRow[];
  /** server 算好的時間,SSR/CSR 一致(同 /admin/users)。 */
  now: number;
  view: AuditView;
  tool: string | null;
  empty: string;
}

/** 截斷後的 JSON 文字可能不再是合法 JSON(尾端有「…」);能 parse 就排版,不能就原樣。 */
function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function absoluteTime(epochMs: number, locale: "en" | "zh-Hant"): string {
  return new Date(epochMs).toLocaleString(locale === "zh-Hant" ? "zh-TW" : "en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

export function AuditLog({ rows, now, view, tool, empty }: AuditLogProps) {
  const t = useT();
  const locale = useLocale();
  const [openId, setOpenId] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <p className="rounded-[12px] bg-white px-4 py-8 text-center text-[13px] text-black/35 shadow-[0_0_0_1px_rgba(20,18,22,0.05),0_1px_2px_-1px_rgba(20,18,22,0.05)]">
        {empty}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-px rounded-[12px] bg-white p-1.5 shadow-[0_0_0_1px_rgba(20,18,22,0.05),0_1px_2px_-1px_rgba(20,18,22,0.05)]">
      {rows.map((row) => {
        const open = openId === row.id;
        return (
          <li key={row.id} className="flex flex-col">
            <button
              type="button"
              onClick={() => setOpenId(open ? null : row.id)}
              aria-expanded={open}
              className={cn(
                "group/row flex w-full items-center gap-2.5 rounded-[8px] px-2 py-2 text-left transition-colors duration-150 hover:bg-black/[0.025]",
                open && "bg-black/[0.025]",
              )}
            >
              <StatusDot tone={row.ok ? "good" : "draft"} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] lowercase">
                <span className="text-black/35">{toolNamespace(row.tool)}.</span>
                <span className="text-black/75">{toolLeaf(row.tool)}</span>
              </span>
              <span
                className={cn(
                  "hidden shrink-0 rounded-[5px] px-1.5 py-px text-[10.5px] sm:inline",
                  row.kind === "write"
                    ? "bg-[rgb(86,114,228)]/[0.08] text-[rgb(86,114,228)]"
                    : "bg-black/[0.045] text-black/45",
                )}
              >
                {t(row.kind === "write" ? "agent.audit.kind.write" : "agent.audit.kind.read")}
              </span>
              {!row.ok && (
                <span className="max-w-[12rem] shrink-0 truncate text-[10.5px] text-red-700/80">
                  {row.error ?? t("agent.toolFailed")}
                </span>
              )}
              <span className="hidden max-w-[11rem] shrink-0 truncate text-[11px] text-black/40 md:inline">
                {row.userEmail}
              </span>
              <time
                dateTime={new Date(row.at).toISOString()}
                title={absoluteTime(row.at, locale)}
                className="shrink-0 text-[11px] tabular-nums text-black/35"
              >
                {relativeTimeWords(row.at, now, locale)}
              </time>
              <ChevronRight
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0 text-black/25 transition-transform duration-150 ease-out",
                  open && "rotate-90",
                )}
              />
            </button>

            {open && (
              <div className="flex flex-col gap-2.5 px-2 pt-1 pb-2.5">
                {/* 中繼資料一行:來源(自動 / 經確認)、誰(窄視窗時列頭放不下才在這裡補)、
                    絕對時間。都是短句,用 flex 排開就好,不套 dl 語意 —— 沒有真正的
                    term/description 配對。 */}
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[11px] text-black/45">
                  <span
                    className={cn(
                      "rounded-[5px] px-1.5 py-px text-[10.5px]",
                      row.source === "execute"
                        ? "bg-[rgb(86,114,228)]/[0.08] text-[rgb(86,114,228)]"
                        : "bg-black/[0.045] text-black/45",
                    )}
                  >
                    {t(row.source === "execute" ? "agent.audit.source.execute" : "agent.audit.source.chat")}
                  </span>
                  <span className="truncate md:hidden">{row.userEmail}</span>
                  <span className="tabular-nums">{absoluteTime(row.at, locale)}</span>
                  {tool !== row.tool && (
                    <Link
                      href={auditHref({ view, tool: row.tool })}
                      className="ml-auto text-[11px] text-black/40 underline-offset-2 transition-colors duration-150 hover:text-black/75 hover:underline"
                    >
                      {t("agent.audit.showTool")}
                    </Link>
                  )}
                </div>
                <Block label={t("agent.audit.args")} body={pretty(row.args)} />
                {row.ok && row.result !== null && (
                  <Block label={t("agent.audit.result")} body={pretty(row.result)} />
                )}
                {!row.ok && row.error && (
                  <Block label={t("agent.audit.error")} body={row.error} danger />
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Block({ label, body, danger }: { label: string; body: string; danger?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10.5px] lowercase text-black/35">{label}</span>
      <pre
        className={cn(
          "max-h-56 overflow-auto rounded-[8px] px-2.5 py-2 font-mono text-[10.5px] leading-relaxed break-words whitespace-pre-wrap",
          danger ? "bg-red-50 text-red-700" : "bg-black/[0.035] text-black/55",
        )}
      >
        {body}
      </pre>
    </div>
  );
}
