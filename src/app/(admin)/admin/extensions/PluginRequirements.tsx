"use client";

import { useState } from "react";
import Link from "next/link";
import { useLocale, useT } from "@/lib/i18n/I18nProvider";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import type { Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  requirementState,
  requirementTargets,
  type RequirementState,
} from "@/ext/plugin-ref";
import {
  entryUnmetPlugins,
  sourceLabel,
  type InstalledPluginRef,
  type RegistryEntry,
  type RequiredPlugin,
} from "./registry-types";

// 1.50.0:商店詳情頁的插件相依 —— 需要哪些插件(裝了沒、啟用了沒、為什麼需要)、
// 哪些插件需要它,以及右欄「為什麼現在不能裝」。資料全來自 /api/registry/index,
// 判斷規則與 install route 同一份(@/ext/plugin-ref),畫面擋下的就是伺服器會擋的。

type Installed = ReadonlyMap<string, InstalledPluginRef>;

const ACTION =
  "inline-flex h-7 items-center rounded-[calc(6px*var(--admin-radius-scale,1))] px-2 text-[12px] font-medium text-(--admin-accent) transition-colors hover:bg-(--admin-accent)/[0.08]";

/** 商店裡對應這個相依的項目。同一個來源的優先(通常是同一個發行者)。 */
export function findListed(
  req: Pick<RequiredPlugin, "id" | "identity">,
  entries: readonly RegistryEntry[],
  preferSource: string,
): RegistryEntry | undefined {
  const matches = entries.filter((e) => requirementTargets(req, e));
  return matches.find((e) => e.source === preferSource) ?? matches[0];
}

function requirementName(
  req: Pick<RequiredPlugin, "id" | "identity">,
  installed: Installed,
  entries: readonly RegistryEntry[],
  preferSource: string,
  locale: Locale,
): string {
  const plugin = installed.get(req.id);
  if (plugin && requirementState(req, plugin) !== "different") {
    return resolveLocalizedString(plugin.name, locale) ?? req.id;
  }
  return findListed(req, entries, preferSource)?.name ?? req.id;
}

/**
 * 一個必要插件的顯示名稱:已安裝的用站上的名稱,否則用商店裡列的;都沒有才用 id。
 * 安裝失敗的訊息(useInstallFlow)也用這個,錯誤訊息裡不出現代號。
 */
export function requiredPluginName(
  entry: RegistryEntry,
  id: string,
  installed: Installed,
  entries: readonly RegistryEntry[],
  locale: Locale,
): string {
  const req = entry.requiresExtensions?.find((r) => r.id === id) ?? { id };
  return requirementName(req, installed, entries, entry.source, locale);
}

function StateLabel({ state, optional }: { state: RequirementState; optional?: boolean }) {
  const t = useT();
  const tone =
    state === "met"
      ? "text-[rgb(18,124,88)]"
      : optional || state === "disabled"
        ? "text-amber-700"
        : "text-red-700";
  const label =
    state === "met"
      ? t("registryBrowser.plugins.enabled")
      : state === "disabled"
        ? t("registryBrowser.plugins.disabled")
        : state === "different"
          ? t("registryBrowser.plugins.different")
          : t("registryBrowser.plugins.missing");
  return <span className={cn("text-[12px] font-medium", tone)}>{label}</span>;
}

/** 詳情頁「需要項目」裡的插件那幾列(放在同一個 <ul> 裡,與服務需求並列)。 */
export function RequiredPluginItems({
  entry,
  installed,
  entries,
  onOpen,
}: {
  entry: RegistryEntry;
  installed: Installed;
  entries: readonly RegistryEntry[];
  onOpen: (entry: RegistryEntry) => void;
}) {
  const t = useT();
  const locale = useLocale();
  return (
    <>
      {(entry.requiresExtensions ?? []).map((req) => {
        const reason = resolveLocalizedString(req.reason, locale);
        const state = requirementState(req, installed.get(req.id));
        const listed = state === "missing" || state === "different" ? findListed(req, entries, entry.source) : undefined;
        return (
          <li key={`ext-${req.id}`} className="flex flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink/80">
              <span className="font-medium">{requirementName(req, installed, entries, entry.source, locale)}</span>
              <StateLabel state={state} optional={req.optional} />
              {req.optional && state !== "met" && (
                <span className="text-[12px] text-ink/40">{t("registryBrowser.plugins.optional")}</span>
              )}
              {listed && (
                <button type="button" className={ACTION} onClick={() => onOpen(listed)}>
                  {t("registryBrowser.plugins.view")}
                </button>
              )}
              {state === "disabled" && (
                <Link href="/admin/extensions" className={ACTION}>
                  {t("registryBrowser.plugins.goEnable")}
                </Link>
              )}
            </span>
            {state === "different" && (
              <span className="text-[12.5px] leading-relaxed text-ink/50">
                {t("registryBrowser.plugins.differentHint")}
              </span>
            )}
            {reason && <span className="text-[12.5px] leading-relaxed text-ink/50">{reason}</span>}
          </li>
        );
      })}
    </>
  );
}

/** 商店裡列著、而且需要這個插件的其他插件。 */
export function dependentsOf(entry: RegistryEntry, entries: readonly RegistryEntry[]): RegistryEntry[] {
  const seen = new Set<string>();
  return entries.filter((other) => {
    if (other.id === entry.id) return false;
    if (!other.requiresExtensions?.some((req) => requirementTargets(req, entry))) return false;
    // 同一個插件在幾個來源都有列:只列一次。
    const key = other.identity ?? other.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function UsedBySection({
  entry,
  entries,
  onOpen,
  className,
}: {
  entry: RegistryEntry;
  entries: readonly RegistryEntry[];
  onOpen: (entry: RegistryEntry) => void;
  className: string;
}) {
  const t = useT();
  const dependents = dependentsOf(entry, entries);
  if (dependents.length === 0) return null;
  return (
    <section className={className}>
      <h2 className="mb-3 text-[15px] font-semibold tracking-[-0.01em] text-ink/85">
        {t("registryBrowser.plugins.usedBy")}
      </h2>
      <div className="flex flex-wrap gap-2">
        {dependents.map((other) => (
          <button
            key={`${other.source}:${other.id}`}
            type="button"
            onClick={() => onOpen(other)}
            className="inline-flex h-8 items-center gap-1.5 rounded-[calc(8px*var(--admin-radius-scale,1))] bg-ink/[0.04] px-3 text-[13px] text-ink/75 transition-[background-color,transform] duration-150 hover:bg-ink/[0.07] active:scale-[0.97]"
          >
            {other.name}
            {other.installed && (
              <span className="text-[11.5px] text-ink/40">{t("registryBrowser.install.installed")}</span>
            )}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * 右欄:這個宣告式插件現在為什麼不能裝。沒有擋的理由就回 null,由呼叫端畫安裝鈕。
 *   - 同 id 已經是別的插件(identity / kind)→ 要先移除
 *   - 從別的來源裝的(source)→ 可以確認後改用這個來源(onReplaceSource)
 *   - 必要插件沒裝或停用 → 列出來,提供前往
 */
export function InstallGate({
  entry,
  installed,
  entries,
  onOpen,
  onReplaceSource,
  busy,
}: {
  entry: RegistryEntry;
  installed: Installed;
  entries: readonly RegistryEntry[];
  onOpen: (entry: RegistryEntry) => void;
  onReplaceSource: (installedSource: string) => void;
  busy: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const [confirming, setConfirming] = useState(false);

  if (entry.conflict === "identity" || entry.conflict === "kind") {
    return <p className="text-[12.5px] leading-relaxed text-red-700">{t("registryBrowser.plugins.conflict")}</p>;
  }

  if (entry.conflict === "source" && entry.installedSource) {
    const installedSource = entry.installedSource;
    return (
      <div className="flex flex-col gap-2.5">
        <p className="text-[12.5px] leading-relaxed text-ink/60">
          {t("registryBrowser.plugins.otherSource", { source: sourceLabel(installedSource) })}
        </p>
        {confirming ? (
          <>
            <p className="text-[12.5px] leading-relaxed text-ink/60">{t("registryBrowser.plugins.replaceRisk")}</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="inline-flex h-8 items-center rounded-[calc(8px*var(--admin-radius-scale,1))] px-3 text-[12.5px] font-medium text-ink/55 transition-colors hover:bg-ink/[0.05]"
              >
                {t("extensions.cancel")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onReplaceSource(installedSource)}
                className="inline-flex h-8 items-center rounded-[calc(8px*var(--admin-radius-scale,1))] bg-ink px-3 text-[12.5px] font-medium text-white transition-[background-color,transform] duration-150 hover:bg-ink/85 active:scale-[0.96] disabled:opacity-45"
              >
                {busy ? t("registryBrowser.install.updating") : t("registryBrowser.plugins.replace")}
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="inline-flex h-10 w-full items-center justify-center rounded-[calc(8px*var(--admin-radius-scale,1))] bg-surface px-4 text-[13px] font-medium text-ink/80 shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_1px_2px_-1px_rgba(0,0,0,0.06)] transition-[box-shadow,transform] duration-150 hover:shadow-[0_0_0_1px_rgba(0,0,0,0.14),0_1px_2px_-1px_rgba(0,0,0,0.08)] active:scale-[0.98]"
          >
            {t("registryBrowser.plugins.useThisSource")}
          </button>
        )}
      </div>
    );
  }

  const unmet = entryUnmetPlugins(entry, installed);
  if (unmet.length === 0) return null;
  const reqs = entry.requiresExtensions ?? [];
  const toInstall = unmet.filter((u) => u.state !== "disabled");
  const toEnable = unmet.filter((u) => u.state === "disabled");
  const nameOf = (id: string) => requiredPluginName(entry, id, installed, entries, locale);
  const firstListed = toInstall
    .map((u) => findListed(reqs.find((r) => r.id === u.id) ?? { id: u.id }, entries, entry.source))
    .find((e): e is RegistryEntry => e !== undefined);

  return (
    <div className="flex flex-col gap-2.5">
      {toInstall.length > 0 && (
        <p className="text-[12.5px] leading-relaxed text-red-700">
          {t("registryBrowser.plugins.needInstall", { names: toInstall.map((u) => nameOf(u.id)).join("、") })}
        </p>
      )}
      {toEnable.length > 0 && (
        <p className="text-[12.5px] leading-relaxed text-amber-700">
          {t("registryBrowser.plugins.needEnable", { names: toEnable.map((u) => nameOf(u.id)).join("、") })}
        </p>
      )}
      {firstListed ? (
        <button
          type="button"
          onClick={() => onOpen(firstListed)}
          className="inline-flex h-10 w-full items-center justify-center rounded-[calc(8px*var(--admin-radius-scale,1))] bg-ink px-4 text-[13px] font-medium text-white transition-[background-color,transform] duration-150 hover:bg-ink/85 active:scale-[0.98]"
        >
          {t("registryBrowser.plugins.open", { name: firstListed.name })}
        </button>
      ) : toEnable.length > 0 ? (
        <Link
          href="/admin/extensions"
          className="inline-flex h-10 w-full items-center justify-center rounded-[calc(8px*var(--admin-radius-scale,1))] bg-ink px-4 text-[13px] font-medium text-white transition-[background-color,transform] duration-150 hover:bg-ink/85 active:scale-[0.98]"
        >
          {t("registryBrowser.plugins.goEnable")}
        </Link>
      ) : null}
    </div>
  );
}
