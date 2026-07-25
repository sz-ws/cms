"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { History, RotateCcw } from "lucide-react";
import { CoreTable, type CoreColumn } from "@/components/admin/core-table";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { StatusButton } from "@/components/ui/status-button";
import { useT, useLocale } from "@/lib/i18n/I18nProvider";
import { relativeTimeWords } from "@/lib/relative-time";
import { StatusBadge } from "./StatusBadge";

// 內容版本紀錄面板(admin 編輯頁下半部)。CoreTable 列表 + 右側 detail sheet 的既有
// 體例(照 /admin/users 的 UsersTable + UserSheet),不另發明視覺語言。
//
// 列表資料由 server component(FormViewPage)直接查好當 prop 傳入 —— 不在 mount 時
// 再打一次自己的 API。`now` 同樣由 server 算好傳入(照 PasskeysManager 的 precedent:
// 相對時間的基準點必須是 prop,否則 SSR/CSR 對不上)。還原成功後走 router.refresh(),
// 由 server 重新查一次,client 不必自己維護列表快取。
//
// 單筆快照(還原前的預覽)才走 HTTP:那是點開才需要、且可能不小的資料,不值得為了
// 每次進編輯頁就把全部版本的完整文件一起送下來。端點見 src/ext/dx/crud.ts。
//
// 只在編輯既有 entry 時掛載(新建頁沒有 id,自然沒有歷史)。

/** 值預覽的長度上限:面板是「看一眼確認是不是這版」,不是完整的內容檢視器。 */
const PREVIEW_MAX = 240;

export interface RevisionRowDTO {
  id: string;
  slug: string | null;
  status: string;
  reason: "create" | "update" | "restore";
  createdAt: number;
  actorName: string | null;
}

interface RevisionDetailDTO extends RevisionRowDTO {
  data: Record<string, unknown>;
}

export interface RevisionHistoryProps {
  extId: string;
  typeName: string;
  entryId: string;
  /** server 查好的版本列表(新→舊)。 */
  revisions: RevisionRowDTO[];
  /** server 端的「現在」,供相對時間顯示;SSR/CSR 一致的前提。 */
  now: number;
}

/** 任意快照值 → 一行可讀預覽(物件/陣列走 JSON,過長截斷)。 */
function preview(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean")
    text = String(value);
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      return "";
    }
  }
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > PREVIEW_MAX
    ? `${collapsed.slice(0, PREVIEW_MAX)}…`
    : collapsed;
}

export function RevisionHistory({
  extId,
  typeName,
  entryId,
  revisions,
  now,
}: RevisionHistoryProps) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState<RevisionRowDTO | null>(null);

  const base = `/api/ext/${extId}/${typeName}/${encodeURIComponent(entryId)}/revisions`;
  const currentId = revisions[0]?.id;

  const reasonLabel = (reason: RevisionRowDTO["reason"]): string =>
    reason === "create"
      ? t("revisions.reason.create")
      : reason === "restore"
        ? t("revisions.reason.restore")
        : t("revisions.reason.update");

  const columns: CoreColumn<RevisionRowDTO>[] = [
    {
      key: "when",
      label: t("revisions.colWhen"),
      sortable: true,
      sortValue: (r) => r.createdAt,
      render: (r) => (
        <span className="flex items-center gap-2">
          <span className="text-[13px] tabular-nums text-black/85">
            {relativeTimeWords(r.createdAt, now, locale)}
          </span>
          {r.id === currentId && (
            <span className="rounded-full bg-[rgb(86,114,228)]/10 px-2 py-0.5 text-[11px] font-medium text-[rgb(86,114,228)]">
              {t("revisions.current")}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "who",
      label: t("revisions.colWho"),
      // 查無使用者(帳號已刪 / 匿名公開建立)→ 整格留白,絕不落地內部 user id。
      render: (r) => (
        <span className="text-[13px] text-black/55">{r.actorName ?? ""}</span>
      ),
    },
    {
      key: "change",
      label: t("revisions.colChange"),
      render: (r) => (
        <span className="text-[13px] text-black/55">{reasonLabel(r.reason)}</span>
      ),
    },
    {
      key: "status",
      label: t("revisions.colStatus"),
      render: (r) => <StatusBadge status={r.status} />,
    },
  ];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em] text-black/90">
          <History className="size-4 text-black/35" aria-hidden />
          {t("revisions.title")}
        </h2>
        <p className="text-[11.5px] text-black/35">{t("revisions.subtitle")}</p>
      </div>

      {revisions.length === 0 ? (
        <p className="text-[13px] text-black/35">{t("revisions.empty")}</p>
      ) : (
        <CoreTable
          columns={columns}
          rows={revisions}
          rowKey={(r) => r.id}
          onRowClick={(r) => setOpen(r)}
          rowActive={(r) => open?.id === r.id}
          trailingLabel={t("revisions.open")}
          minWidth={460}
        />
      )}

      <RevisionSheet
        base={base}
        summary={open}
        now={now}
        isCurrent={open !== null && open.id === currentId}
        onClose={() => setOpen(null)}
        onRestored={() => {
          setOpen(null);
          router.refresh(); // server 重查列表 + 表單初值。
        }}
      />
    </section>
  );
}

// 殼常駐、open 由 summary 是否為 null 驅動(同 UserSheet 註解的理由:條件式 mount +
// open=true 會讓 base-ui 跳過 starting-style,面板瞬間出現)。held 保留最後一個非
// null summary,讓退場動畫期間內容不消失;session key 讓每次重開都是全新狀態。
function RevisionSheet({
  base,
  summary,
  now,
  isCurrent,
  onClose,
  onRestored,
}: {
  base: string;
  summary: RevisionRowDTO | null;
  now: number;
  isCurrent: boolean;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [held, setHeld] = useState<RevisionRowDTO | null>(summary);
  const [session, setSession] = useState(0);
  if (summary && summary !== held) {
    // render-time adjust(官方 adjust-state-when-props-change 模式)
    setHeld(summary);
    setSession((n) => n + 1);
  }

  return (
    <Sheet open={summary !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        showCloseButton
        className="duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-[side=right]:sm:max-w-[28rem]"
      >
        {held && (
          <RevisionSheetBody
            key={session}
            base={base}
            summary={held}
            now={now}
            isCurrent={isCurrent}
            onRestored={onRestored}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function RevisionSheetBody({
  base,
  summary,
  now,
  isCurrent,
  onRestored,
}: {
  base: string;
  summary: RevisionRowDTO;
  now: number;
  isCurrent: boolean;
  onRestored: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [detail, setDetail] = useState<RevisionDetailDTO | null>(null);
  const [state, setState] = useState<"idle" | "confirm" | "busy" | "error">(
    "idle",
  );
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`${base}/${encodeURIComponent(summary.id)}`);
        if (!res.ok) return;
        const body = (await res.json()) as { revision?: RevisionDetailDTO };
        if (alive && body.revision) setDetail(body.revision);
      } catch {
        // 預覽取不到不影響還原本身;下方仍可按還原鈕。
      }
    })();
    return () => {
      alive = false;
    };
  }, [base, summary.id]);

  async function restore() {
    if (state === "idle") {
      setState("confirm"); // 兩段式:第一次點是確認,第二次才真的送出。
      return;
    }
    setState("busy");
    setNotice(null);
    try {
      const res = await fetch(
        `${base}/${encodeURIComponent(summary.id)}/restore`,
        { method: "POST" },
      );
      if (!res.ok) {
        setState("error");
        setNotice(t("revisions.restoreFailed"));
        return;
      }
      const body = (await res.json()) as { restored?: { slugKept?: boolean } };
      if (body.restored?.slugKept) {
        // 還原成功,但舊 slug 被別人佔用 → 明確講出來,不要靜默改掉語意。
        setNotice(t("revisions.slugKept"));
        setState("idle");
        window.setTimeout(onRestored, 1800);
        return;
      }
      onRestored();
    } catch {
      setState("error");
      setNotice(t("revisions.restoreFailed"));
    }
  }

  const entries = detail ? Object.entries(detail.data) : [];
  const when = relativeTimeWords(summary.createdAt, now, locale);

  return (
    <>
      <SheetHeader>
        <SheetTitle>{t("revisions.sheetTitle", { when })}</SheetTitle>
        <SheetDescription>
          {summary.actorName
            ? t("revisions.sheetBy", { name: summary.actorName })
            : t("revisions.subtitle")}
        </SheetDescription>
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6">
        {isCurrent && (
          <p className="rounded-[8px] bg-black/[0.03] px-3 py-2 text-[12.5px] text-black/55">
            {t("revisions.isCurrent")}
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-black/55">
            {t("revisions.snapshot")}
          </span>
          {entries.length === 0 ? (
            <p className="text-[13px] text-black/35">
              {t("revisions.emptySnapshot")}
            </p>
          ) : (
            <dl className="flex flex-col gap-2.5 rounded-[10px] bg-white p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06)]">
              {entries.map(([key, value]) => (
                <div key={key} className="flex flex-col gap-0.5">
                  <dt className="font-mono text-[11px] lowercase text-black/35">
                    {key}
                  </dt>
                  <dd className="text-[13px] break-words text-black/85">
                    {preview(value)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        {summary.slug && (
          <div className="flex flex-col gap-0.5">
            <span className="text-[12.5px] font-medium text-black/55">
              {t("revisions.slugLabel")}
            </span>
            <span className="font-mono text-[12px] text-black/55">
              {summary.slug}
            </span>
          </div>
        )}

        {notice && (
          <p className="rounded-[8px] bg-black/[0.03] px-3 py-2 text-[12.5px] text-black/55">
            {notice}
          </p>
        )}
      </div>

      <SheetFooter>
        <StatusButton
          status={
            state === "busy" ? "loading" : state === "error" ? "error" : "idle"
          }
          idleIcon={<RotateCcw className="size-4" aria-hidden />}
          label={
            state === "busy"
              ? t("revisions.restoring")
              : state === "confirm"
                ? t("revisions.restoreConfirm")
                : t("revisions.restore")
          }
          onClick={() => void restore()}
        />
      </SheetFooter>
    </>
  );
}
