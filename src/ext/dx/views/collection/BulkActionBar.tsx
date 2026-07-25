"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import NumberFlow from "@number-flow/react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";

// 選取 ≥1 列時浮現的動作列:Publish / Unpublish / Delete(二段確認)。
// 逐 id 呼叫 CRUD API(PUT status / DELETE),完成後 router.refresh()。
// Paper & Ink:白 surface + 浮層 shadow,8px 控制,delete 紅只在確認步驟。

interface BulkActionBarProps {
  extId: string;
  typeName: string;
  ids: string[];
  onDone: () => void;
}

type Busy = null | "publish" | "unpublish" | "delete";

export function BulkActionBar({
  extId,
  typeName,
  ids,
  onDone,
}: BulkActionBarProps) {
  const router = useRouter();
  const t = useT();
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = ids.length;
  if (count === 0) return null;

  const base = `/api/ext/${extId}/${typeName}`;

  async function runStatus(status: "published" | "draft", kind: Busy) {
    setError(null);
    setBusy(kind);
    try {
      const results = await Promise.all(
        ids.map((id) =>
          fetch(`${base}/${encodeURIComponent(id)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status }),
          }),
        ),
      );
      if (results.some((r) => !r.ok)) setError(t("collection.bulk.updateFailed"));
      onDone();
      router.refresh();
    } catch {
      setError(t("collection.bulk.networkError"));
    } finally {
      setBusy(null);
    }
  }

  async function runDelete() {
    setError(null);
    setBusy("delete");
    try {
      const results = await Promise.all(
        ids.map((id) =>
          fetch(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" }),
        ),
      );
      if (results.some((r) => !r.ok)) setError(t("collection.bulk.deleteFailed"));
      setConfirmingDelete(false);
      onDone();
      router.refresh();
    } catch {
      setError(t("collection.bulk.networkError"));
    } finally {
      setBusy(null);
    }
  }

  const btn =
    "inline-flex h-9 items-center rounded-[8px] px-3 text-[13px] font-medium transition-[background,box-shadow,transform] active:scale-[0.96] disabled:opacity-50";

  return (
    <div className="sticky bottom-4 z-10 mx-auto flex w-fit items-center gap-3 rounded-[14px] bg-white px-3 py-2 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_16px_48px_-12px_rgba(30,20,50,0.18)]">
      <span className="inline-flex items-center gap-1.5 pl-1 text-[13px] text-black/70">
        <span className="inline-flex size-3 items-center justify-center rounded-full ring-1 ring-[rgb(86,114,228)]">
          <span className="size-1 rounded-full bg-[rgb(86,114,228)]" />
        </span>
        <NumberFlow
          value={count}
          className="tabular-nums font-medium text-black/90"
        />
        <span className="text-black/45">{t("collection.bulk.selected")}</span>
      </span>

      <span className="h-5 w-px bg-black/10" />

      {error && <span className="text-[12px] text-red-700">{error}</span>}

      {confirmingDelete ? (
        <>
          <span className="text-[13px] text-black/55">
            {t("collection.bulk.deleteCount", { count })}
          </span>
          <button
            type="button"
            disabled={busy !== null}
            onClick={runDelete}
            className={cn(
              btn,
              "bg-red-50 text-red-700 shadow-[0_0_0_1px_rgba(220,38,38,0.15)] hover:bg-red-100",
            )}
          >
            {busy === "delete" ? "…" : t("collection.bulk.confirmDelete")}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => setConfirmingDelete(false)}
            className={cn(btn, "text-black/55 hover:text-black/80")}
          >
            {t("collection.bulk.cancel")}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => runStatus("published", "publish")}
            className={cn(
              btn,
              "bg-white text-black/80 shadow-[0_0_0_1px_rgba(0,0,0,0.1)] hover:shadow-[0_0_0_1px_rgba(0,0,0,0.22)]",
            )}
          >
            {busy === "publish" ? "…" : t("collection.bulk.publish")}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => runStatus("draft", "unpublish")}
            className={cn(
              btn,
              "bg-white text-black/80 shadow-[0_0_0_1px_rgba(0,0,0,0.1)] hover:shadow-[0_0_0_1px_rgba(0,0,0,0.22)]",
            )}
          >
            {busy === "unpublish" ? "…" : t("collection.bulk.unpublish")}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => setConfirmingDelete(true)}
            className={cn(btn, "text-red-700/80 hover:text-red-700")}
          >
            {t("collection.bulk.delete")}
          </button>
          <button
            type="button"
            onClick={onDone}
            className={cn(btn, "text-black/40 hover:text-black/70")}
          >
            {t("collection.bulk.clear")}
          </button>
        </>
      )}
    </div>
  );
}
