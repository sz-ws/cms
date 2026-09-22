"use client";

import { startTransition, useState } from "react";
import { useRouter } from "next/navigation";
import NumberFlow from "@number-flow/react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n";
import type { BulkAction } from "./optimistic";

// 選取 ≥1 列時浮現的動作列:Publish / Unpublish / Delete(二段確認)。
// Paper & Ink:白 surface + 浮層 shadow,8px 控制,delete 紅只在確認步驟。
//
// 樂觀更新:按下去就清掉選取、把列畫成結果(onOptimistic,見 ./optimistic.ts),
// 逐 id 呼叫 CRUD API(PUT status / DELETE)放在 transition 裡背景跑。有任何一筆成功,
// server 那邊就變了,router.refresh() 取回真實結果(在同一個 transition 裡,新資料到之前
// 畫面維持樂觀的樣子,不會先閃回舊狀態);全部失敗則 transition 結束時列表自己退回原狀。
// 錯誤訊息在選取清空之後仍留在這條列上 —— 否則列表退回原狀、使用者卻不知道為什麼。

interface BulkActionBarProps {
  extId: string;
  typeName: string;
  ids: string[];
  onDone: () => void;
  /** 把動作先畫到列表上(父層 useOptimistic 的 setter;在 transition 裡呼叫)。 */
  onOptimistic: (action: BulkAction) => void;
}

export function BulkActionBar({
  extId,
  typeName,
  ids,
  onDone,
  onOptimistic,
}: BulkActionBarProps) {
  const router = useRouter();
  const t = useT();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = ids.length;
  if (count === 0 && error === null) return null;

  const base = `/api/ext/${extId}/${typeName}`;

  function run(
    action: BulkAction,
    request: (id: string) => Promise<Response>,
    failed: MessageKey,
  ) {
    setError(null);
    setConfirmingDelete(false);
    onDone();
    startTransition(async () => {
      onOptimistic(action);
      const results = await Promise.allSettled(action.ids.map(request));
      const ok = results.filter(
        (r) => r.status === "fulfilled" && r.value.ok,
      ).length;
      if (results.some((r) => r.status === "rejected")) {
        setError(t("collection.bulk.networkError"));
      } else if (ok < results.length) {
        setError(t(failed));
      }
      if (ok > 0) router.refresh();
    });
  }

  function runStatus(status: "published" | "draft") {
    run(
      { kind: "status", ids, status },
      (id) =>
        fetch(`${base}/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        }),
      "collection.bulk.updateFailed",
    );
  }

  function runDelete() {
    run(
      { kind: "delete", ids },
      (id) => fetch(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" }),
      "collection.bulk.deleteFailed",
    );
  }

  const btn =
    "inline-flex h-9 items-center rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] px-3 text-[13px] font-medium transition-[background,box-shadow,transform] active:scale-[0.96] disabled:opacity-50";
  const bar =
    "sticky bottom-4 z-10 mx-auto flex w-fit items-center gap-3 rounded-[14px] admin:rounded-[calc(14px*var(--admin-radius-scale,1))] bg-white admin:bg-surface px-3 py-2 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_16px_48px_-12px_rgba(30,20,50,0.18)] admin:shadow-[var(--admin-shadow-panel,0_0_0_1px_rgba(0,0,0,0.06),0_16px_48px_-12px_rgba(30,20,50,0.18))]";

  // 選取已清空、只剩上一次動作的錯誤。
  if (count === 0) {
    return (
      <div className={bar}>
        <span role="alert" className="pl-1 text-[12px] text-red-700">
          {error}
        </span>
        <button
          type="button"
          onClick={() => setError(null)}
          className={cn(btn, "text-black/40 admin:text-ink/40 hover:text-black/70 admin:hover:text-ink/70")}
        >
          {t("collection.bulk.dismiss")}
        </button>
      </div>
    );
  }

  return (
    <div className={bar}>
      <span className="inline-flex items-center gap-1.5 pl-1 text-[13px] text-black/70 admin:text-ink/70">
        <span className="inline-flex size-3 items-center justify-center rounded-full ring-1 ring-(--admin-accent)">
          <span className="size-1 rounded-full bg-(--admin-accent)" />
        </span>
        <NumberFlow
          value={count}
          className="tabular-nums font-medium text-black/90 admin:text-ink/90"
        />
        <span className="text-black/45 admin:text-ink/45">{t("collection.bulk.selected")}</span>
      </span>

      <span className="h-5 w-px bg-black/10 admin:bg-ink/10" />

      {error && (
        <span role="alert" className="text-[12px] text-red-700">
          {error}
        </span>
      )}

      {confirmingDelete ? (
        <>
          <span className="text-[13px] text-black/55 admin:text-ink/55">
            {t("collection.bulk.deleteCount", { count })}
          </span>
          <button
            type="button"
            onClick={runDelete}
            className={cn(
              btn,
              "bg-red-50 text-red-700 shadow-[0_0_0_1px_rgba(220,38,38,0.15)] hover:bg-red-100",
            )}
          >
            {t("collection.bulk.confirmDelete")}
          </button>
          <button
            type="button"
            onClick={() => setConfirmingDelete(false)}
            className={cn(btn, "text-black/55 admin:text-ink/55 hover:text-black/80 admin:hover:text-ink/80")}
          >
            {t("collection.bulk.cancel")}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => runStatus("published")}
            className={cn(
              btn,
              "bg-white admin:bg-surface text-black/80 admin:text-ink/80 shadow-[0_0_0_1px_rgba(0,0,0,0.1)] admin:shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.1))] hover:shadow-[0_0_0_1px_rgba(0,0,0,0.22)]",
            )}
          >
            {t("collection.bulk.publish")}
          </button>
          <button
            type="button"
            onClick={() => runStatus("draft")}
            className={cn(
              btn,
              "bg-white admin:bg-surface text-black/80 admin:text-ink/80 shadow-[0_0_0_1px_rgba(0,0,0,0.1)] admin:shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.1))] hover:shadow-[0_0_0_1px_rgba(0,0,0,0.22)]",
            )}
          >
            {t("collection.bulk.unpublish")}
          </button>
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className={cn(btn, "text-red-700/80 hover:text-red-700")}
          >
            {t("collection.bulk.delete")}
          </button>
          <button
            type="button"
            onClick={onDone}
            className={cn(btn, "text-black/40 admin:text-ink/40 hover:text-black/70 admin:hover:text-ink/70")}
          >
            {t("collection.bulk.clear")}
          </button>
        </>
      )}
    </div>
  );
}
