"use client";

import { startTransition, useOptimistic, useState } from "react";
import { AdminLink } from "@/components/admin/AdminLink";
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
import { useTimeZone } from "@/components/DateTimeProvider";
import { cn } from "@/lib/utils";
import { stableReducer } from "@/lib/optimistic";
import type { SubmissionState } from "../submission";
import { applyInboxAction, type InboxAction } from "./inbox-optimistic";

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

// 狀態變更與刪除先畫到列上(見 ./inbox-optimistic.ts);server 資料回來就被取代。
const reduceRows = stableReducer<InboxRowDTO[], InboxAction>(
  applyInboxAction,
);

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
  const timeZone = useTimeZone();
  const router = useRouter();
  const [shownRows, applyOptimistic] = useOptimistic<
    InboxRowDTO[],
    InboxAction
  >(rows, reduceRows);
  // sheet 以 id 尋址,內容永遠取自 shownRows:樂觀變更馬上反映在 sheet 上。
  // InboxSheet 用 `row !== held` 留住最後一筆,靠的是 stableReducer 讓同一列在
  // transition 期間的每次 render 都是同一個物件(見 src/lib/optimistic.ts)。
  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId
    ? (shownRows.find((r) => r.id === openId) ?? null)
    : null;
  const [error, setError] = useState<string | null>(null);

  const endpoint = (id: string) =>
    `/api/ext/${extId}/${typeName}/${encodeURIComponent(id)}/inbox`;

  /**
   * 先把 action 畫上去,API 在 transition 裡背景跑。成功後 router.refresh() 由 server
   * 重查列表與各狀態筆數 —— 同一個 transition,新資料到之前畫面維持樂觀的樣子,
   * 不會先閃回舊狀態。失敗:transition 結束時列表自己退回原狀,並顯示錯誤。
   * 回傳的 promise 在 server 回應後才 settle,sheet 的按鈕靠它顯示成功 / 失敗。
   */
  const mutate = (
    action: InboxAction,
    request: () => Promise<Response>,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      setError(null);
      startTransition(async () => {
        applyOptimistic(action);
        try {
          const res = await request();
          if (!res.ok) throw new Error(String(res.status));
          router.refresh();
          resolve();
        } catch (e) {
          setError(t("inbox.actionFailed"));
          reject(e);
        }
      });
    });

  /** 收件狀態變更(樂觀,見 mutate)。 */
  const patch = (
    id: string,
    body: { state?: SubmissionState; replied?: boolean },
  ): Promise<void> =>
    mutate({ kind: "patch", id, ...body, at: Date.now() }, () =>
      fetch(endpoint(id), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  const remove = (id: string): Promise<void> =>
    mutate({ kind: "delete", id }, () =>
      fetch(`/api/ext/${extId}/${typeName}/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    );

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
            {relativeTimeWords(r.createdAt, now, locale, timeZone)}
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
            <AdminLink
              key={tab.value || "all"}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] transition-colors",
                active
                  ? "bg-(--admin-accent)/10 font-medium text-(--admin-accent)"
                  : "text-black/55 hover:bg-black/[0.04] hover:text-black/80",
              )}
            >
              {tab.label}
              <span className="tabular-nums text-black/35">{tab.count}</span>
            </AdminLink>
          );
        })}
      </nav>

      {error && (
        <p
          role="alert"
          className="rounded-[8px] border border-red-600/15 bg-red-50 px-3 py-2 text-[13px] text-red-700"
        >
          {error}
        </p>
      )}

      {shownRows.length === 0 ? (
        <p className="rounded-[12px] bg-black/[0.02] px-4 py-8 text-center text-[13px] text-black/35">
          {t("inbox.empty")}
        </p>
      ) : (
        <CoreTable
          columns={columns}
          rows={shownRows}
          rowKey={(r) => r.id}
          onRowClick={(r) => {
            setOpenId(r.id);
            // 開啟即視為已讀 —— 這是收件匣唯一該自動發生的狀態轉換。
            // 失敗只顯示錯誤(mutate 已處理),這裡不必再接。
            if (r.state === "unread") {
              patch(r.id, { state: "read" }).catch(() => {});
            }
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
        error={error}
        onClose={() => setOpenId(null)}
        onPatch={patch}
        onRemove={(id) => {
          // 先關 sheet:列已經從列表拿掉了。失敗時列會回來,錯誤顯示在列表上方。
          setOpenId(null);
          return remove(id);
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
          <AdminLink href={href(page - 1)} className="hover:text-black/80">
            {t("inbox.prev")}
          </AdminLink>
        )}
        {page < last && (
          <AdminLink href={href(page + 1)} className="hover:text-black/80">
            {t("inbox.next")}
          </AdminLink>
        )}
      </span>
    </nav>
  );
}

/** 成功的打勾停留多久後歸位(StatusButton 在 success 狀態是 disabled)。 */
const ACTION_SUCCESS_MS = 1200;

/**
 * sheet footer 的單一動作鈕。自己持有 StatusButton 的 idle/loading/success/error
 * 狀態 —— 每顆鈕各自獨立,才不會按了「封存」卻讓「刪除」也跟著轉圈。
 * 成功狀態短暫顯示後歸位;失敗停在 error,操作者看得見而不是靜靜地什麼都沒發生。
 * 歸位是必要的:樂觀更新讓「標記已回覆」當場變成「取消已回覆」,同一顆鈕若停在
 * success(disabled),就沒辦法立刻反悔。
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
          () => {
            setStatus("success");
            setTimeout(() => setStatus("idle"), ACTION_SUCCESS_MS);
          },
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
  error,
  onClose,
  onPatch,
  onRemove,
}: {
  row: InboxRowDTO | null;
  fields: InboxFieldMeta[];
  now: number;
  /** 上一個動作的錯誤。按下去的那顆鈕可能已因樂觀更新換成另一顆,所以另外顯示。 */
  error: string | null;
  onClose: () => void;
  onPatch: (
    id: string,
    body: { state?: SubmissionState; replied?: boolean },
  ) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const t = useT();
  const locale = useLocale();
  const timeZone = useTimeZone();
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
              ? relativeTimeWords(shown.createdAt, now, locale, timeZone)
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
                {relativeTimeWords(shown.repliedAt as number, now, locale, timeZone)}
              </dd>
            </div>
          )}
        </dl>

        <SheetFooter>
          {error && row !== null && (
            <p role="alert" className="text-[12.5px] text-red-700">
              {error}
            </p>
          )}
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
