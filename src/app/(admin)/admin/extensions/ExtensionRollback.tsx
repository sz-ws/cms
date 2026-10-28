"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n";
import type { ExtensionRow } from "./ExtensionsManager";

// 宣告式插件的「回到上一版」:安裝路由用存下來的那一份走同一條安裝流程(rollback: true,
// migrations/0027)。擋下來的原因照錯誤碼講白話,沒列到的才露出代碼。

const ERROR_KEYS: Partial<Record<string, MessageKey>> = {
  migration_history_changed: "extensions.rollback.error.migrations",
  incompatible_setting_contract: "extensions.rollback.error.settings",
  scripts_review_required: "extensions.rollback.error.scripts",
  scripts_changed: "extensions.rollback.error.scripts",
  no_previous_version: "extensions.rollback.error.gone",
};

export function ExtensionRollback({ ext }: { ext: ExtensionRow }) {
  const t = useT();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const version = ext.previousVersion;
  if (!version) return null;

  async function rollback() {
    setWorking(true);
    setError(null);
    try {
      const res = await fetch("/api/registry/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ext.id, rollback: true }),
      });
      if (res.ok) {
        setConfirming(false);
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const key = body.error ? ERROR_KEYS[body.error] : undefined;
      setError(key ? t(key) : t("extensions.rollback.error.other", { code: body.error ?? String(res.status) }));
    } catch {
      setError(t("extensions.rollback.error.network"));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-ink/[0.06] pt-5">
      <span className="text-[11px] font-medium text-ink/45">{t("extensions.rollback.title")}</span>
      <span className="text-[12.5px] text-ink/60">{t("extensions.rollback.desc", { version })}</span>
      {confirming ? (
        <div className="flex flex-col gap-3 rounded-[calc(10px*var(--admin-radius-scale,1))] bg-ink/[0.03] px-3.5 py-3">
          <span className="text-[12.5px] text-ink/75">{t("extensions.rollback.confirm", { version })}</span>
          <span className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-[calc(6px*var(--admin-radius-scale,1))] px-2 py-1 text-[12px] text-ink/50 transition-colors hover:bg-ink/[0.05]"
            >
              {t("extensions.cancel")}
            </button>
            <button
              type="button"
              disabled={working}
              onClick={rollback}
              className="rounded-[calc(6px*var(--admin-radius-scale,1))] bg-ink px-2.5 py-1 text-[12px] font-medium text-white transition-[background-color,transform] active:scale-[0.96] disabled:cursor-wait disabled:opacity-60"
            >
              {working ? "…" : t("extensions.rollback.action", { version })}
            </button>
          </span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="flex w-fit items-center gap-1.5 rounded-[calc(8px*var(--admin-radius-scale,1))] border border-ink/[0.12] px-3 py-1.5 text-[12.5px] font-medium text-ink/70 transition-[background-color,transform] hover:bg-ink/[0.04] active:scale-[0.96]"
        >
          <Undo2 className="size-3.5" />
          {t("extensions.rollback.action", { version })}
        </button>
      )}
      {error && <span className="text-[12px] text-red-600/80">{error}</span>}
    </div>
  );
}
