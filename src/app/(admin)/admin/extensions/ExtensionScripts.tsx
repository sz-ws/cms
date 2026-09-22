"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";
import type { DeclarativeScript } from "@/ext/dx/scripts";
import { ScriptReviewDialog } from "./ScriptReviewDialog";
import type { ExtensionRow } from "./ExtensionsManager";

// 1.48.0:已安裝的宣告式插件的前台 script —— 執行中可以停用,停用後要重新核准
// 才能再打開(api/extensions/[extId]/scripts)。

interface ReviewData {
  scripts: DeclarativeScript[];
  hash: string;
}

export function ExtensionScripts({ ext }: { ext: ExtensionRow }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewData | null>(null);
  const running = ext.scripts === "running";

  async function send(body: Record<string, unknown>): Promise<boolean> {
    const res = await fetch(`/api/extensions/${ext.id}/scripts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      router.refresh();
      return true;
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    setError(
      data.error === "scripts_not_allowed"
        ? t("scripts.notAllowed")
        : data.error === "scripts_changed"
          ? t("scripts.changed")
          : t("extensions.actionFailed"),
    );
    return false;
  }

  async function stop() {
    setBusy(true);
    setError(null);
    try {
      await send({ action: "stop" });
    } catch {
      setError(t("extensions.networkError"));
    } finally {
      setBusy(false);
    }
  }

  async function openReview() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/extensions/${ext.id}/scripts`);
      const data = (await res.json().catch(() => ({}))) as Partial<ReviewData> & {
        allowed?: boolean;
      };
      if (!res.ok || !data.scripts || !data.hash) {
        setError(t("extensions.actionFailed"));
      } else if (!data.allowed) {
        setError(t("scripts.notAllowed"));
      } else {
        setReview({ scripts: data.scripts, hash: data.hash });
      }
    } catch {
      setError(t("extensions.networkError"));
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!review) return;
    setBusy(true);
    setError(null);
    try {
      if (await send({ action: "approve", hash: review.hash })) setReview(null);
    } catch {
      setError(t("extensions.networkError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between rounded-[calc(10px*var(--admin-radius-scale,1))] border border-ink/[0.08] px-3.5 py-2.5">
        <span className="flex items-center gap-2 text-[12.5px] text-ink/70">
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full", running ? "bg-green-600" : "bg-ink/25")}
          />
          {running ? t("extensions.sheet.scriptsRunning") : t("extensions.sheet.scriptsStopped")}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void (running ? stop() : openReview())}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-[calc(8px*var(--admin-radius-scale,1))] px-3 text-[12.5px] font-medium transition-[background-color,transform] active:scale-[0.96]",
            running ? "text-ink/55 hover:bg-ink/[0.05]" : "bg-ink text-white hover:bg-ink/85",
            busy && "cursor-wait opacity-60",
          )}
        >
          {busy && !review && <Loader2 className="size-3.5 animate-spin" />}
          {running ? t("extensions.sheet.scriptsStop") : t("extensions.sheet.scriptsReview")}
        </button>
      </div>
      <span className="text-[11px] leading-relaxed text-ink/35">{t("extensions.sheet.scriptsDesc")}</span>
      {error && !review && (
        <div
          role="alert"
          className="flex gap-2 rounded-[calc(8px*var(--admin-radius-scale,1))] border border-red-600/15 bg-red-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-red-700"
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {error}
        </div>
      )}
      {review && (
        <ScriptReviewDialog
          extensionId={ext.id}
          extensionName={ext.name}
          scripts={review.scripts}
          confirmLabel={t("scripts.approveEnable")}
          submitting={busy}
          error={error}
          onCancel={() => {
            setReview(null);
            setError(null);
          }}
          onConfirm={() => void approve()}
        />
      )}
    </>
  );
}
