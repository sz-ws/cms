"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, CornerUpLeft, Inbox, MailOpen, Trash2 } from "lucide-react";
import { CoreTable, type CoreColumn } from "@/components/admin/core-table";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  StatusButton,
  type StatusButtonStatus,
} from "@/components/ui/status-button";
import { useT, useLocale } from "@/lib/i18n/I18nProvider";
import { relativeTimeWords } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import type { SubmissionState } from "../submission";

// 收件匣的互動層。體例照 RevisionHistory / UsersTable:CoreTable 列表 + 右側 detail
// sheet,不另發明視覺語言。未讀以左緣一條實心色條 + 較深的字重表示 —— 靜態,沒有
// 任何脈動 / 呼吸光暈(那是明確的禁區)。

export interface InboxFieldMeta {
  key: string;
  label: string;
}

export interface InboxRowDTO {
  id: string;
  state: SubmissionState;
  repliedAt: number | null;
  createdAt: number;
  /** 列表欄位的已格式化值(對應 listFields 順序)。 */
  cells: string[];
  /** 全部欄位的已格式化值(對應 detailFields 順序)。 */
  detail: string[];
}

interface InboxTab {
  value: SubmissionState | "";
  label: string;
  count: number;
}

export interface InboxTableProps {
  extId: string;
  typeName: string;
  rows: InboxRowDTO[];
  listFields: InboxFieldMeta[];
  detailFields: InboxFieldMeta[];
  tabs: InboxTab[];
  activeTab: SubmissionState | "";
  base: string;
  page: number;
  perPage: number;
  total: number;
  /** server 端的「現在」;相對時間 SSR/CSR 一致的前提(同 RevisionHistory)。 */
  now: number;
}

export function InboxTable({
  extId,
  typeName,
  rows,
  listFields,
  detailFields,
  tabs,
  activeTab,
  base,
  page,
  perPage,
  total,
  now,
}: InboxTableProps) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState<InboxRowDTO | null>(null);

  const endpoint = (id: string) =>
    `/api/ext/${extId}/${typeName}/${encodeURIComponent(id)}/inbox`;

  /** 收件狀態變更。成功後 router.refresh(),由 server 重查列表與各狀態筆數。 */
  const patch = async (
    id: string,
    body: { state?: SubmissionState; replied?: boolean },
  ): Promise<void> => {
    const res = await fetch(endpoint(id), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(String(res.status));
    router.refresh();
  };

  const remove = async (id: string): Promise<void> => {
    const res = await fetch(
      `/api/ext/${extId}/${typeName}/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    if (!res.ok) throw new Error(String(res.status));
    router.refresh();
  };

  const columns: CoreColumn<InboxRowDTO>[] = [
    ...listFields.map((f, i) => ({
      key: f.key,
      label: f.label,
      render: (r: InboxRowDTO) => (
        <span
          className={cn(
            "text-[13px]",
            r.state === "unread"
              ? "font-medium text-black/90"
              : "text-black/60",
            r.state === "archived" && "text-black/40",
          )}
        >
          {r.cells[i] || "—"}
        </span>
      ),
    })),
    {
      key: "received",
      label: t("inbox.colReceived"),
      sortable: true,
      sortValue: (r) => r.createdAt,
      render: (r) => (
        <span className="flex items-center gap-2 whitespace-nowrap">
          <span className="text-[13px] tabular-nums text-black/55">
            {relativeTimeWords(r.createdAt, now, locale)}
          </span>
          {r.repliedAt !== null && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-black/[0.05] px-2 py-0.5 text-[11px] font-medium text-black/55"
              title={t("inbox.repliedOn")}
            >
              <CornerUpLeft className="size-3" aria-hidden />
              {t("inbox.replied")}
            </span>
          )}
        </span>
      ),
    },
  ];

  return (
    <section className="flex flex-col gap-3">
      <nav
        className="flex flex-wrap items-center gap-1"
        aria-label={t("inbox.filterLabel")}
      >
        {tabs.map((tab) => {
          const href = tab.value ? `${base}?state=${tab.value}` : base;
          const active = tab.value === activeTab;
          return (
            <Link
              key={tab.value || "all"}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] transition-colors",
                active
                  ? "bg-[rgb(86,114,228)]/10 font-medium text-[rgb(86,114,228)]"
                  : "text-black/55 hover:bg-black/[0.04] hover:text-black/80",
              )}
            >
              {tab.label}
              <span className="tabular-nums text-black/35">{tab.count}</span>
            </Link>
          );
        })}
      </nav>

      {rows.length === 0 ? (
        <p className="rounded-[12px] bg-black/[0.02] px-4 py-8 text-center text-[13px] text-black/35">
          {t("inbox.empty")}
        </p>
      ) : (
        <CoreTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => {
            setOpen(r);
            // 開啟即視為已讀 —— 這是收件匣唯一該自動發生的狀態轉換。
            if (r.state === "unread") void patch(r.id, { state: "read" });
          }}
          rowActive={(r) => open?.id === r.id}
          trailingLabel={t("inbox.open")}
          minWidth={520}
        />
      )}

      {total > perPage && (
        <Pagination base={base} activeTab={activeTab} page={page} perPage={perPage} total={total} />
      )}

      <InboxSheet
        row={open}
        fields={detailFields}
        now={now}
        onClose={() => setOpen(null)}
        onPatch={patch}
        onRemove={async (id) => {
          await remove(id);
          setOpen(null);
        }}
      />
    </section>
  );
}

function Pagination({
  base,
  activeTab,
  page,
  perPage,
  total,
}: {
  base: string;
  activeTab: SubmissionState | "";
  page: number;
  perPage: number;
  total: number;
}) {
  const t = useT();
  const last = Math.max(1, Math.ceil(total / perPage));
  const href = (p: number): string => {
    const params = new URLSearchParams();
    if (activeTab) params.set("state", activeTab);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  };
  return (
    <nav className="flex items-center justify-between text-[12.5px] text-black/45">
      <span className="tabular-nums">
        {t("inbox.pageOf")
          .replace("{page}", String(page))
          .replace("{last}", String(last))}
      </span>
      <span className="flex gap-2">
        {page > 1 && (
          <Link href={href(page - 1)} className="hover:text-black/80">
            {t("inbox.prev")}
          </Link>
        )}
        {page < last && (
          <Link href={href(page + 1)} className="hover:text-black/80">
            {t("inbox.next")}
          </Link>
        )}
      </span>
    </nav>
  );
}

/**
 * sheet footer 的單一動作鈕。自己持有 StatusButton 的 idle/loading/success/error
 * 狀態 —— 每顆鈕各自獨立,才不會按了「封存」卻讓「刪除」也跟著轉圈。
 * 成功狀態短暫顯示後歸位;失敗停在 error,操作者看得見而不是靜靜地什麼都沒發生。
 */
function ActionButton({
  label,
  icon,
  run,
}: {
  label: string;
  icon: React.ReactNode;
  run: () => Promise<void>;
}) {
  const [status, setStatus] = useState<StatusButtonStatus>("idle");
  return (
    <StatusButton
      status={status}
      label={label}
      size="sm"
      variant="soft"
      idleIcon={icon}
      onClick={() => {
        if (status === "loading") return;
        setStatus("loading");
        void run().then(
          () => setStatus("success"),
          () => setStatus("error"),
        );
      }}
    />
  );
}

// 殼常駐、open 由 row 是否為 null 驅動(理由同 RevisionHistory 的 RevisionSheet:
// 條件式 mount + open=true 會讓 base-ui 跳過 starting-style,面板瞬間出現)。
// held 保留最後一個非 null row,讓退場動畫期間內容不消失。
function InboxSheet({
  row,
  fields,
  now,
  onClose,
  onPatch,
  onRemove,
}: {
  row: InboxRowDTO | null;
  fields: InboxFieldMeta[];
  now: number;
  onClose: () => void;
  onPatch: (
    id: string,
    body: { state?: SubmissionState; replied?: boolean },
  ) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const t = useT();
  const locale = useLocale();
  const [held, setHeld] = useState<InboxRowDTO | null>(row);
  if (row !== null && row !== held) setHeld(row);
  const shown = row ?? held;

  return (
    <Sheet open={row !== null} onOpenChange={(next) => !next && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{t("inbox.detailTitle")}</SheetTitle>
          <SheetDescription>
            {shown
              ? relativeTimeWords(shown.createdAt, now, locale)
              : ""}
          </SheetDescription>
        </SheetHeader>

        <dl className="flex flex-col gap-4 px-4 py-2">
          {shown &&
            fields.map((f, i) => (
              <div key={f.key} className="flex flex-col gap-1">
                <dt className="text-[11px] uppercase tracking-[0.06em] text-black/35">
                  {f.label}
                </dt>
                <dd className="whitespace-pre-wrap break-words text-[13.5px] text-black/85">
                  {shown.detail[i] || "—"}
                </dd>
              </div>
            ))}
          {shown?.repliedAt !== null && shown !== null && (
            <div className="flex flex-col gap-1">
              <dt className="text-[11px] uppercase tracking-[0.06em] text-black/35">
                {t("inbox.repliedOn")}
              </dt>
              <dd className="text-[13.5px] text-black/85">
                {relativeTimeWords(shown.repliedAt as number, now, locale)}
              </dd>
            </div>
          )}
        </dl>

        <SheetFooter>
          {shown && (
            <div className="flex flex-wrap gap-2">
              <ActionButton
                label={
                  shown.repliedAt === null
                    ? t("inbox.markReplied")
                    : t("inbox.unmarkReplied")
                }
                icon={<CornerUpLeft className="size-3.5" aria-hidden />}
                run={() =>
                  onPatch(shown.id, { replied: shown.repliedAt === null })
                }
              />
              {shown.state === "archived" ? (
                <ActionButton
                  label={t("inbox.unarchive")}
                  icon={<Inbox className="size-3.5" aria-hidden />}
                  run={() => onPatch(shown.id, { state: "read" })}
                />
              ) : (
                <ActionButton
                  label={t("inbox.archive")}
                  icon={<Archive className="size-3.5" aria-hidden />}
                  run={() => onPatch(shown.id, { state: "archived" })}
                />
              )}
              {shown.state !== "unread" && (
                <ActionButton
                  label={t("inbox.markUnread")}
                  icon={<MailOpen className="size-3.5" aria-hidden />}
                  run={() => onPatch(shown.id, { state: "unread" })}
                />
              )}
              <ActionButton
                label={t("inbox.delete")}
                icon={<Trash2 className="size-3.5" aria-hidden />}
                run={() => onRemove(shown.id)}
              />
            </div>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
