"use client";

import { Trash2 } from "lucide-react";
import { StackedListItem } from "@/components/ui/stacked-list";
import { FaceIdIcon } from "@/components/ui/face-id-icon";
import { relativeTimeWords } from "@/lib/relative-time";
import { useT, useLocale } from "@/lib/i18n/I18nProvider";
import type { PasskeySummary } from "@/components/admin/PasskeysManager";

interface PasskeyRowProps {
  passkey: PasskeySummary;
  now: number;
  confirming: boolean;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}

// 一列 passkey:圖示 + 名稱 + 相對時間,滑過才浮現刪除鈕 —— 點一次不會直接刪,
// 而是原地換成「Remove? Cancel / Remove」的二段確認(取代 window.confirm)。
export function PasskeyRow({
  passkey,
  now,
  confirming,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: PasskeyRowProps) {
  const t = useT();
  const locale = useLocale();
  return (
    <StackedListItem>
      <div className="group flex items-center gap-3 border-t border-black/[0.06] px-4 py-3 transition-colors duration-150 ease-out first:border-t-0 hover:bg-black/[0.02]">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-[8px] bg-black/[0.04] text-black/55">
          <FaceIdIcon className="size-4" />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[14px] font-medium text-black/85">
            {passkey.name}
          </span>
          <span className="truncate text-[11.5px] tabular-nums text-black/40">
            {t("passkey.added", { relative: relativeTimeWords(passkey.createdAt, now, locale) })}
            {passkey.lastUsedAt != null &&
              ` · ${t("passkey.lastUsed", { relative: relativeTimeWords(passkey.lastUsedAt, now, locale) })}`}
          </span>
        </div>

        {confirming ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-[12px] text-black/45">{t("passkey.removeConfirm")}</span>
            <button
              type="button"
              onClick={onCancelDelete}
              className="flex h-8 items-center rounded-[6px] px-2.5 text-[12px] font-medium text-black/55 transition-[background-color,transform] duration-150 hover:bg-black/[0.06] active:scale-[0.96]"
            >
              {t("passkey.cancel")}
            </button>
            <button
              type="button"
              onClick={onConfirmDelete}
              className="flex h-8 items-center rounded-[6px] bg-red-600 px-2.5 text-[12px] font-medium text-white transition-[background-color,transform] duration-150 hover:bg-red-700 active:scale-[0.96]"
            >
              {t("passkey.remove")}
            </button>
          </div>
        ) : (
          // size-10 = 40px 最小 hit area;圖示置中,hover 才浮現(桌面滑鼠語彙,跟
          // Api/RegistrySources 兩支 manager 的既有列表列一致)。
          <button
            type="button"
            onClick={onRequestDelete}
            aria-label={`Remove ${passkey.name}`}
            className="flex size-10 shrink-0 items-center justify-center rounded-[8px] text-black/35 opacity-0 transition-[opacity,background-color,color] duration-150 group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 active:scale-[0.96]"
          >
            <Trash2 className="size-4" />
          </button>
        )}
      </div>
    </StackedListItem>
  );
}
