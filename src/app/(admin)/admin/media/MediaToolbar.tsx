"use client";

import { useState } from "react";
import { SearchIcon, CopyIcon, CheckIcon, Trash2Icon, XIcon } from "lucide-react";
import NumberFlow from "@number-flow/react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";

// Task #7 §2: search input + live count (NumberFlow/tabular-nums) + the
// selection action cluster (copy key/url when exactly one asset is selected,
// delete with a two-step confirm — red only on the confirm step per
// docs/admin-design-language.md).

interface MediaToolbarProps {
  query: string;
  onQueryChange: (q: string) => void;
  total: number;
  selectedKeys: string[];
  onClearSelection: () => void;
  onDelete: () => Promise<void>;
  deleting: boolean;
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — no-op.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex h-9 items-center gap-1.5 rounded-[calc(8px*var(--admin-radius-scale,1))] bg-surface px-3 text-[13px] font-medium text-ink/70 shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.08))] transition-[box-shadow,transform] active:scale-[0.96] hover:shadow-[0_0_0_1px_rgba(0,0,0,0.18)]"
    >
      {copied ? (
        <CheckIcon className="size-3.5 text-(--admin-accent)" />
      ) : (
        <CopyIcon className="size-3.5 text-ink/35" />
      )}
      {copied ? "Copied" : label}
    </button>
  );
}

export function MediaToolbar({
  query,
  onQueryChange,
  total,
  selectedKeys,
  onClearSelection,
  onDelete,
  deleting,
}: MediaToolbarProps) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const count = selectedKeys.length;
  const single = count === 1 ? selectedKeys[0] : null;
  const singleUrl = single
    ? typeof window !== "undefined"
      ? `${window.location.origin}/api/files/${single}`
      : `/api/files/${single}`
    : null;

  async function confirmDelete() {
    await onDelete();
    setConfirming(false);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="relative flex items-center">
            <SearchIcon className="pointer-events-none absolute left-2.5 size-3.5 text-ink/30" />
            <input
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder={t("mediaToolbar.filterPlaceholder")}
              className={cn(
                "h-9 w-56 rounded-[calc(8px*var(--admin-radius-scale,1))] border-none bg-surface pl-8 pr-3 text-[13px] text-ink/85 outline-none placeholder:text-ink/30",
                "shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.08))] transition-[box-shadow] duration-150 ease-out",
                "focus:shadow-[0_0_0_1px_rgba(0,0,0,0.2),0_0_0_3px_rgba(0,0,0,0.05)]",
              )}
            />
          </span>
          <p className="text-[12px] tabular-nums text-ink/40">
            <NumberFlow value={total} className="text-ink/70" style={{ fontVariantNumeric: "tabular-nums" }} />
            <span className="pl-1">{total === 1 ? t("mediaToolbar.asset") : t("mediaToolbar.assets")}</span>
          </p>
        </div>

        {count > 0 && (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-[13px] text-ink/55">
              <span className="inline-flex size-3 items-center justify-center rounded-full ring-1 ring-(--admin-accent)">
                <span className="size-1 rounded-full bg-(--admin-accent)" />
              </span>
              <NumberFlow value={count} className="tabular-nums font-medium text-ink/90" />
              <span>{t("mediaToolbar.selected")}</span>
            </span>

            {single && (
              <>
                <CopyButton label={t("mediaToolbar.copyKey")} value={single} />
                <CopyButton label={t("mediaToolbar.copyUrl")} value={singleUrl ?? ""} />
              </>
            )}

            {confirming ? (
              <>
                <span className="text-[13px] text-ink/55">{t("mediaToolbar.deleteConfirm", { count })}</span>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => void confirmDelete()}
                  className="inline-flex h-9 items-center rounded-[calc(8px*var(--admin-radius-scale,1))] bg-red-50 px-3 text-[13px] font-medium text-red-700 shadow-[0_0_0_1px_rgba(220,38,38,0.15)] transition-[background-color,transform] active:scale-[0.96] hover:bg-red-100 disabled:opacity-50"
                >
                  {deleting ? t("mediaToolbar.deleting") : t("mediaToolbar.confirmDelete")}
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => setConfirming(false)}
                  className="inline-flex h-9 items-center rounded-[calc(8px*var(--admin-radius-scale,1))] px-3 text-[13px] font-medium text-ink/55 transition-colors hover:text-ink/80"
                >
                  {t("mediaToolbar.cancel")}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="inline-flex h-9 items-center gap-1.5 rounded-[calc(8px*var(--admin-radius-scale,1))] px-3 text-[13px] font-medium text-red-700/80 transition-colors hover:text-red-700"
              >
                <Trash2Icon className="size-3.5" />
                {t("mediaToolbar.delete")}
              </button>
            )}

            <button
              type="button"
              onClick={onClearSelection}
              className="inline-flex h-9 items-center gap-1 rounded-[calc(8px*var(--admin-radius-scale,1))] px-2 text-[13px] font-medium text-ink/40 transition-colors hover:text-ink/70"
            >
              <XIcon className="size-3.5" />
              {t("mediaToolbar.clear")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
