"use client";

import { useState } from "react";
import { Power, Trash2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";
import {
  StatusPill,
  KindBadge,
  type ExtensionRow,
  type Action,
} from "./ExtensionsManager";

// /admin/extensions 的詳情 sidebar(core-native「設定從側邊滑出」體例,同 UserSheet)。
// 殼常駐、open 由 request 是否為 null 驅動 —— 條件式 mount + open=true 會讓 base-ui
// 跳過 starting-style,面板瞬間出現;常駐切 open 才有進退場動畫。held 保留最後一個
// 非 null request,退場動畫期間內容不消失;seq 每次打開遞增當 body 的 key ——
// 確認面板等內部狀態全新(列上的垃圾桶會以 confirm=true 打開,直接落在確認面板)。
// uninstall 的「是否連內容刪除」在這裡用 checkbox 交代(取代舊的 window.confirm
// OK/Cancel 雙關語義)。

export interface ExtensionSheetRequest {
  ext: ExtensionRow;
  confirm: boolean;
  seq: number;
}

export function ExtensionSheet({
  request,
  pending,
  onClose,
  onAction,
}: {
  request: ExtensionSheetRequest | null;
  pending: string | null;
  onClose: () => void;
  onAction: (
    extId: string,
    action: Action,
    kind: ExtensionRow["kind"],
    purgeContent?: boolean,
  ) => void;
}) {
  const [held, setHeld] = useState<ExtensionSheetRequest | null>(request);
  // render-time adjust(官方 adjust-state-when-props-change 模式)。request 物件
  // 每次 render 重建,拿內容比對,避免 identity 比較造成無限 re-render。
  if (
    request &&
    (held === null || request.seq !== held.seq || request.ext !== held.ext)
  ) {
    setHeld(request);
  }

  return (
    <Sheet open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton
        className="duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-[side=right]:sm:max-w-[25rem]"
      >
        {held && (
          <ExtensionSheetBody
            key={held.seq}
            ext={held.ext}
            initialConfirm={held.confirm}
            pending={pending}
            onAction={onAction}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function ExtensionSheetBody({
  ext,
  initialConfirm,
  pending,
  onAction,
}: {
  ext: ExtensionRow;
  initialConfirm: boolean;
  pending: string | null;
  onAction: (
    extId: string,
    action: Action,
    kind: ExtensionRow["kind"],
    purgeContent?: boolean,
  ) => void;
}) {
  const t = useT();
  const [confirmUninstall, setConfirmUninstall] = useState(initialConfirm);
  const [purge, setPurge] = useState(false);
  const busy = pending !== null;
  const toggling =
    pending === `${ext.id}:enable` || pending === `${ext.id}:disable`;
  const uninstalling = pending === `${ext.id}:uninstall`;

  return (
    <>
      <SheetHeader className="border-b border-black/[0.06] pb-5">
        <SheetTitle className="flex items-center gap-2 text-[16px] font-semibold tracking-[-0.01em] text-black/90">
          {ext.name}
          <KindBadge kind={ext.kind} />
        </SheetTitle>
        <SheetDescription className="text-[12.5px] text-black/40">
          {ext.description || t("extensions.noDescription")}
        </SheetDescription>
      </SheetHeader>

      <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
        {/* About:版本 / ID / 類型的安靜清單 */}
        <div className="flex flex-col gap-3.5">
          <SectionLabel>{t("extensions.sheet.about")}</SectionLabel>
          <div className="flex flex-col rounded-[10px] bg-black/[0.03] px-3.5">
            <MetaRow label={t("extensions.version")}>
              <span className="tabular-nums">{ext.version}</span>
            </MetaRow>
            <MetaRow label={t("extensions.sheet.id")}>
              <code className="font-mono text-[12px] text-black/55">
                {ext.id}
              </code>
            </MetaRow>
            <MetaRow label={t("extensions.sheet.kind")}>
              {ext.kind === "declarative"
                ? t("extensions.declarative")
                : t("extensions.sheet.kindCode")}
            </MetaRow>
          </div>
        </div>

        {/* Status:琺瑯 pill + 就地切換 */}
        <div className="flex flex-col gap-3.5">
          <SectionLabel>{t("extensions.status")}</SectionLabel>
          <div className="flex items-center justify-between rounded-[10px] border border-black/[0.08] px-3.5 py-2.5">
            <StatusPill enabled={ext.enabled} />
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                onAction(ext.id, ext.enabled ? "disable" : "enable", ext.kind)
              }
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-[8px] px-3 text-[12.5px] font-medium transition-[background-color,transform] active:scale-[0.96]",
                ext.enabled
                  ? "text-black/55 hover:bg-black/[0.05]"
                  : "bg-black text-white hover:bg-black/85",
                busy && "cursor-wait opacity-60",
              )}
            >
              <Power className="size-3.5" />
              {toggling
                ? "…"
                : ext.enabled
                  ? t("extensions.disable")
                  : t("extensions.enable")}
            </button>
          </div>
        </div>

        {/* Danger zone */}
        {ext.installed && (
          <div className="mt-2 flex flex-col gap-2 border-t border-black/[0.06] pt-5">
            <SectionLabel tone="danger">
              {t("extensions.sheet.dangerZone")}
            </SectionLabel>
            {confirmUninstall ? (
              <div className="flex flex-col gap-3 rounded-[10px] border border-red-600/20 bg-red-50 px-3.5 py-3">
                <span className="text-[12.5px] font-medium text-red-700">
                  {t("extensions.sheet.uninstallConfirm", { name: ext.name })}
                </span>
                {ext.kind === "declarative" && (
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      checked={purge}
                      onChange={(e) => setPurge(e.target.checked)}
                      className="mt-0.5 size-3.5 accent-red-600"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-[12.5px] text-red-700">
                        {t("extensions.sheet.purgeContent")}
                      </span>
                      <span className="text-[11px] leading-relaxed text-red-700/70">
                        {t("extensions.sheet.purgeHint")}
                      </span>
                    </span>
                  </label>
                )}
                <span className="flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => setConfirmUninstall(false)}
                    className="rounded-[6px] px-2 py-1 text-[12px] text-black/50 transition-colors hover:bg-black/[0.05]"
                  >
                    {t("extensions.cancel")}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      onAction(ext.id, "uninstall", ext.kind, purge)
                    }
                    className="rounded-[6px] bg-red-600 px-2.5 py-1 text-[12px] font-medium text-white transition-[background-color,transform] hover:bg-red-700 active:scale-[0.96] disabled:cursor-wait disabled:opacity-60"
                  >
                    {uninstalling ? "…" : t("extensions.uninstall")}
                  </button>
                </span>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmUninstall(true)}
                className="flex w-fit items-center gap-1.5 rounded-[8px] border border-red-600/20 px-3 py-1.5 text-[12.5px] font-medium text-red-600 transition-[background-color,transform] hover:bg-red-50 active:scale-[0.96]"
              >
                <Trash2 className="size-3.5" />
                {t("extensions.uninstall")}
              </button>
            )}
            <span className="text-[11px] text-black/30">
              {t("extensions.sheet.uninstallDesc")}
            </span>
          </div>
        )}
      </div>
    </>
  );
}

function SectionLabel({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "danger";
}) {
  return (
    <h3
      className={cn(
        "text-[11px] font-semibold tracking-[0.06em] uppercase",
        tone === "danger" ? "text-red-600/70" : "text-black/35",
      )}
    >
      {children}
    </h3>
  );
}

function MetaRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-9 items-center justify-between border-t border-black/[0.05] text-[13px] text-black/60 first:border-t-0">
      <span className="text-black/40">{label}</span>
      {children}
    </div>
  );
}
