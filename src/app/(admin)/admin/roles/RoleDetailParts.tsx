"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { ROLE_NAME_MAX, type PresetRole } from "@/ext/admin-access";
import { useT } from "@/lib/i18n/I18nProvider";

// 角色詳情的頭與尾:名稱(預設角色唯讀、自訂角色可改)、成員數、刪除。

const PRESET_HINT = {
  admin: "userSheet.roleAdminHint",
  editor: "userSheet.roleEditorHint",
  guest: "userSheet.roleGuestHint",
} as const;

function MemberCount({ members }: { members: number }) {
  const t = useT();
  return (
    <span className="text-[12px] text-ink/40 tabular-nums">
      {members === 0
        ? t("roles.members.none")
        : members === 1
          ? t("roles.members.one")
          : t("roles.members.other", { n: members })}
    </span>
  );
}

export function RoleDetailHeader({
  preset,
  name,
  members,
  onRename,
  onStartFrom,
  autoFocus,
}: {
  preset: PresetRole | null;
  name: string;
  /** null = 還沒儲存的新角色。 */
  members: number | null;
  onRename: (name: string) => void;
  onStartFrom: (preset: PresetRole) => void;
  autoFocus: boolean;
}) {
  const t = useT();
  if (preset) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-ink/90">{name}</h2>
          <p className="text-[12.5px] leading-relaxed text-ink/45">{t(PRESET_HINT[preset])}</p>
          {members !== null && <MemberCount members={members} />}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[calc(10px*var(--admin-radius-scale,1))] bg-ink/[0.03] px-3.5 py-2.5">
          <span className="text-[12.5px] text-ink/50">{t("roles.presetNote")}</span>
          <button
            type="button"
            onClick={() => onStartFrom(preset)}
            className="flex h-8 items-center rounded-[calc(8px*var(--admin-radius-scale,1))] bg-surface px-3 text-[12.5px] font-medium text-ink/70 shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.05))] transition-[color,transform] duration-150 hover:text-ink/90 active:scale-[0.96]"
          >
            {t("roles.startFrom")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="role-name" className="text-[12.5px] font-medium text-ink/55">
        {t("roles.nameLabel")}
      </label>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <input
          id="role-name"
          value={name}
          maxLength={ROLE_NAME_MAX}
          onChange={(event) => onRename(event.target.value)}
          placeholder={t("roles.namePlaceholder")}
          autoFocus={autoFocus}
          autoComplete="off"
          className="h-10 w-full max-w-xs rounded-[calc(8px*var(--admin-radius-scale,1))] border border-ink/10 bg-surface px-3 text-[15px] font-semibold text-ink/90 transition-[border-color,box-shadow] duration-150 outline-none placeholder:font-normal placeholder:text-ink/25 focus:border-ink/30 focus:shadow-[0_0_0_3px_rgba(0,0,0,0.05)]"
        />
        {members !== null && <MemberCount members={members} />}
      </div>
    </div>
  );
}

export function RoleDeleteZone({ members, onDelete }: { members: number; onDelete: () => void }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const message =
    members === 0
      ? t("roles.deleteConfirm.none")
      : members === 1
        ? t("roles.deleteConfirm.one")
        : t("roles.deleteConfirm.other", { n: members });
  return (
    <div className="flex border-t border-ink/[0.06] pt-3">
      {confirming ? (
        <div
          role="alertdialog"
          aria-label={t("roles.delete")}
          className="flex w-full flex-wrap items-center justify-between gap-3 rounded-[calc(10px*var(--admin-radius-scale,1))] border border-red-600/15 bg-red-50 px-3.5 py-2.5"
        >
          <span className="text-[12.5px] text-red-700">{message}</span>
          <span className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-[calc(6px*var(--admin-radius-scale,1))] px-2 py-1 text-[12px] text-ink/50 transition-colors hover:bg-ink/[0.05]"
            >
              {t("roles.cancel")}
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="rounded-[calc(6px*var(--admin-radius-scale,1))] bg-red-600 px-2.5 py-1 text-[12px] font-medium text-white transition-[background-color,transform] hover:bg-red-700 active:scale-[0.96]"
            >
              {t("roles.delete")}
            </button>
          </span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className={cn(
            "h-8 rounded-[calc(8px*var(--admin-radius-scale,1))] px-2.5 text-[12.5px] font-medium text-ink/40",
            "transition-[background-color,color,transform] duration-150 hover:bg-red-50 hover:text-red-600 active:scale-[0.96]",
          )}
        >
          {t("roles.delete")}
        </button>
      )}
    </div>
  );
}
