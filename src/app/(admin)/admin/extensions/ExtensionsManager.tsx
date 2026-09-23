"use client";

import { startTransition, useOptimistic, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import NumberFlow from "@number-flow/react";
import { TextMorph } from "torph/react";
import { CircleAlert, CircleArrowUp, Power, Trash2 } from "lucide-react";
import { CoreTable, RowIconButton, type CoreColumn } from "@/components/admin/core-table";
import { RegistryBrowser } from "./RegistryBrowser";
import { DevInstallTrigger } from "./DevInstallDialog";
import { ExtensionSheet } from "./ExtensionSheet";
import {
  EnableProgressCard,
  applyStepEvent,
  initialSteps,
  markFailed,
  withMigrations,
  type EnableProgressState,
} from "./EnableProgress";
import type { EnableStepEvent } from "@/ext/manager";
import { cn } from "@/lib/utils";
import { stableReducer } from "@/lib/optimistic";
import { useT } from "@/lib/i18n/I18nProvider";
import type { ExtensionRuntimeIssue } from "@/ext/loader";
import {
  applyExtensionsAction,
  type ExtensionsAction,
} from "./extensions-optimistic";

export interface ExtensionRow {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  installed: boolean;
  kind: "code" | "declarative";
  issue: ExtensionRuntimeIssue | null;
  /** 1.45.0:已部署新版、但還沒套用(migration 沒跑或資料庫記的是舊版號)。 */
  upgrade?: { from: string; to: string; migrations: string[] } | null;
  /**
   * 1.48.0:宣告式插件帶前台 script 時的狀態;沒有 script = 不給。
   * 1.51.0:compiled = 前台已編進網站,script 不會輸出,也不用核准。
   */
  scripts?: "running" | "stopped" | "compiled" | null;
  /** 1.50.0:需要、但沒裝(missing / different)或停用(disabled)的插件;都齊了 = 不給。 */
  needs?: { id: string; name: string; state: "missing" | "disabled" | "different" }[];
}

/** 1.50.0:缺的必要插件,分成「要先安裝」與「要先啟用」兩句(列表與詳情共用)。 */
export function needsLines(
  t: ReturnType<typeof useT>,
  needs: NonNullable<ExtensionRow["needs"]>,
): string[] {
  const install = needs.filter((n) => n.state !== "disabled").map((n) => n.name);
  const enable = needs.filter((n) => n.state === "disabled").map((n) => n.name);
  return [
    ...(install.length > 0 ? [t("extensions.needs.install", { names: install.join("、") })] : []),
    ...(enable.length > 0 ? [t("extensions.needs.enable", { names: enable.join("、") })] : []),
  ];
}

class EnableStepError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason || `enable step failed (${status})`);
  }
}

/** 1.45.0:啟用的一步(api/extensions/[extId] 的 action "enable-step")。 */
async function enableStep(
  extId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/extensions/${extId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "enable-step", kind: "code", ...body }),
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok && data?.ok === true) return data;
  throw new EnableStepError(res.status, typeof data?.error === "string" ? data.error : "");
}

interface ExtensionsManagerProps {
  extensions: ExtensionRow[];
}

export type Action = "enable" | "disable" | "uninstall";
type Tab = "installed" | "browse";

// 琺瑯 pill(頂光 + 內高光 + 同色 hairline,配方同 users 的 RolePill):
// enabled 走綠、disabled 走中性。TextMorph 讓 enable/disable 切換時字自己變形。
export function StatusPill({
  enabled,
  issue,
}: {
  enabled: boolean;
  issue?: ExtensionRuntimeIssue | null;
}) {
  const t = useT();
  const unavailable = enabled && issue !== null && issue !== undefined;
  const label = unavailable
    ? t("extensions.unavailable")
    : enabled
      ? t("extensions.enabled")
      : t("extensions.disabled");
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
        unavailable
          ? "text-red-700"
          : enabled
            ? "text-[rgb(18,124,88)]"
            : "text-ink/50",
      )}
      style={{
        backgroundImage:
          "linear-gradient(180deg, rgba(255,255,255,0.55), rgba(255,255,255,0) 58%)",
        backgroundColor: unavailable
          ? "rgba(254,226,226,0.9)"
          : enabled
            ? "rgba(16,145,90,0.12)"
            : "rgba(0,0,0,0.05)",
        boxShadow: unavailable
          ? "inset 0 1px 0 rgba(255,255,255,0.6), inset 0 0 0 1px rgba(220,38,38,0.18), 0 1px 1.5px rgba(127,29,29,0.08)"
          : enabled
          ? "inset 0 1px 0 rgba(255,255,255,0.6), inset 0 0 0 1px rgba(16,145,90,0.18), 0 1px 1.5px rgba(20,90,60,0.08)"
          : "inset 0 1px 0 rgba(255,255,255,0.6), inset 0 0 0 1px rgba(0,0,0,0.06), 0 1px 1.5px rgba(0,0,0,0.04)",
      }}
    >
      {unavailable && <CircleAlert className="size-3" aria-hidden="true" />}
      <TextMorph respectReducedMotion>
        {label}
      </TextMorph>
    </span>
  );
}

export function KindBadge({ kind }: { kind: ExtensionRow["kind"] }) {
  const t = useT();
  if (kind !== "declarative") return null;
  return (
    <span
      className="inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-medium text-[color-mix(in_srgb,var(--admin-accent)_88%,black)]"
      style={{
        backgroundColor: "color-mix(in srgb,var(--admin-accent) 10%,transparent)",
        boxShadow: "inset 0 0 0 1px color-mix(in srgb,var(--admin-accent) 16%,transparent)",
      }}
    >
      {t("extensions.declarative")}
    </span>
  );
}

// 啟停 / 移除先畫到列表上(見 ./extensions-optimistic.ts)。stableReducer 讓同一列在
// transition 期間的每次 render 都是同一個物件 —— ExtensionSheet 以 `request.ext !==
// held.ext` 判斷要不要換內容,參照每次都變就會無限 re-render(見 src/lib/optimistic.ts)。
const reduceExtensions = stableReducer<ExtensionRow[], ExtensionsAction>(
  applyExtensionsAction,
);

function InstalledTab({ extensions }: { extensions: ExtensionRow[] }) {
  const t = useT();
  const router = useRouter();
  const [rows, applyOptimistic] = useOptimistic<
    ExtensionRow[],
    ExtensionsAction
  >(extensions, reduceExtensions);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 1.45.0:啟用／套用更新的逐步進度(EnableProgress.tsx)。
  const [progress, setProgress] = useState<EnableProgressState | null>(null);
  // sheet 以 id 尋址,資料永遠取自 rows(樂觀變更與 router.refresh() 後的新資料都就地
  // 反映;uninstall 後找不到該列 → request 變 null → sheet 退場)。
  // seq 每次「打開」遞增,當 sheet body 的 key —— 確認面板等內部狀態全新。
  const [open, setOpen] = useState<{
    id: string;
    confirm: boolean;
    seq: number;
  } | null>(null);

  function openSheet(id: string, confirm: boolean) {
    setOpen((prev) => ({ id, confirm, seq: (prev?.seq ?? 0) + 1 }));
  }

  const openExt = open ? (rows.find((e) => e.id === open.id) ?? null) : null;

  // 狀態先換(樂觀),API 在 transition 裡背景跑。成功:同一個 transition 裡
  // router.refresh() —— 啟停會改側欄選單,layout 非重畫不可,但新資料到之前畫面維持
  // 樂觀的樣子。失敗:transition 結束時列表自己退回原狀,並顯示原因。
  // pending 只擋重複送出與顯示「…」,在 server 回應時就放開,不等 refresh。
  // 1.45.0:code extension 的啟用與套用更新一步一步做,每一步畫在進度卡上。
  function runWithProgress(ext: ExtensionRow) {
    const upgrade = ext.enabled && ext.upgrade ? ext.upgrade : null;
    setError(null);
    setPending(`${ext.id}:enable`);
    setProgress({
      extId: ext.id,
      name: ext.name,
      upgrade: upgrade ? { from: upgrade.from, to: upgrade.to } : undefined,
      steps: initialSteps(upgrade ? upgrade.migrations : null),
      outcome: "running",
    });
    const update = (fn: (prev: EnableProgressState) => EnableProgressState) =>
      setProgress((prev) => (prev && prev.extId === ext.id ? fn(prev) : prev));
    const on = (event: EnableStepEvent) =>
      update((prev) => ({ ...prev, steps: applyStepEvent(prev.steps, event) }));
    startTransition(async () => {
      if (!ext.enabled) applyOptimistic({ id: ext.id, action: "enable" });
      try {
        on({ step: "check", status: "running" });
        const checked = await enableStep(ext.id, { step: "check" });
        on({ step: "check", status: "done" });
        const ids = Array.isArray(checked.migrations)
          ? checked.migrations.filter((id): id is string => typeof id === "string")
          : [];
        update((prev) => ({ ...prev, steps: withMigrations(prev.steps, ids) }));
        if (ids.length === 0) on({ step: "migrate", status: "skipped" });
        for (const id of ids) {
          on({ step: "migrate", status: "running", migration: id });
          await enableStep(ext.id, { step: "migrate", migration: id });
          on({ step: "migrate", status: "done", migration: id });
        }
        on({ step: "settings", status: "running" });
        const settled = await enableStep(ext.id, { step: "settings" });
        on({ step: "settings", status: "done", count: typeof settled.count === "number" ? settled.count : 0 });
        on({ step: "record", status: "running" });
        await enableStep(ext.id, { step: "record" });
        on({ step: "record", status: "done" });
        update((prev) => ({ ...prev, outcome: "done" }));
        router.refresh();
      } catch (e) {
        const message =
          e instanceof EnableStepError
            ? e.status === 409 && e.reason
              ? e.reason
              : e.status === 403
                ? t("extensions.notAllowed")
                : t("extensions.enableIncomplete")
            : t("extensions.networkError");
        update((prev) => ({ ...prev, outcome: "failed", error: message, steps: markFailed(prev.steps) }));
      } finally {
        setPending(null);
      }
    });
  }

  function run(
    extId: string,
    action: Action,
    kind: ExtensionRow["kind"],
    purgeContent?: boolean,
  ) {
    const row = rows.find((r) => r.id === extId);
    if (action === "enable" && kind === "code" && row) {
      runWithProgress(row);
      return;
    }
    setError(null);
    setPending(`${extId}:${action}`);
    startTransition(async () => {
      applyOptimistic({ id: extId, action });
      try {
        const res = await fetch(`/api/extensions/${extId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, kind, purgeContent }),
        });
        if (res.ok) {
          router.refresh();
        } else if (res.status === 403) {
          setError(t("extensions.notAllowed"));
        } else if (res.status === 500 && action === "enable") {
          setError(t("extensions.enableIncomplete"));
        } else if (res.status === 409) {
          // 相依或 canDisable 守門(src/ext/code-lifecycle.ts)回的是給人看的原因,
          // 例如「請先啟用必要插件:wallet, inventory」—— 直接顯示,不要縮成「操作失敗」。
          const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
          setError(typeof body?.error === "string" && body.error ? body.error : t("extensions.actionFailed"));
        } else {
          setError(t("extensions.actionFailed"));
        }
      } catch {
        setError(t("extensions.networkError"));
      } finally {
        setPending(null);
      }
    });
  }

  const columns: CoreColumn<ExtensionRow>[] = [
    {
      key: "name",
      label: t("extensions.name"),
      sortable: true,
      sortValue: (e) => e.name.toLowerCase(),
      tdClass: "py-3 pr-4",
      render: (e) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-[13.5px] font-medium text-ink/85">
            <span className="truncate">{e.name}</span>
            <KindBadge kind={e.kind} />
          </span>
          {e.description && (
            <span className="max-w-[36ch] truncate text-[12px] text-ink/40">
              {e.description}
            </span>
          )}
          {e.needs && e.needs.length > 0 && (
            <span className="flex max-w-[40ch] items-start gap-1 text-[12px] leading-snug text-red-700">
              <CircleAlert className="mt-px size-3 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                {needsLines(t, e.needs).map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </span>
            </span>
          )}
        </span>
      ),
    },
    {
      key: "version",
      label: t("extensions.version"),
      sortable: true,
      sortValue: (e) => e.version,
      render: (e) =>
        e.enabled && e.upgrade ? (
          <span className="flex flex-col gap-0.5">
            <span className="text-[12.5px] whitespace-nowrap text-ink/45 tabular-nums">
              {e.upgrade.from} → {e.upgrade.to}
            </span>
            <span className="text-[11px] font-medium whitespace-nowrap text-(--admin-accent)">
              {t("extensions.upgradePending")}
            </span>
          </span>
        ) : (
          <span className="text-[12.5px] whitespace-nowrap text-ink/45 tabular-nums">
            {e.version}
          </span>
        ),
    },
    {
      key: "status",
      label: t("extensions.status"),
      sortable: true,
      sortValue: (e) => (e.enabled ? 0 : 1),
      render: (e) => <StatusPill enabled={e.enabled} issue={e.issue} />,
    },
  ];

  if (rows.length === 0) {
    return (
      <div className="rounded-[calc(14px*var(--admin-radius-scale,1))] border border-dashed border-ink/20 p-8 text-center">
        <p className="text-[13px] text-ink/45">
          {t("extensions.noExtensions")}
        </p>
      </div>
    );
  }

  // 有 migration 沒跑的更新:相關頁面在套用前可能出錯,放在最上面提醒。
  const urgent = rows.filter((e) => e.enabled && e.upgrade && e.upgrade.migrations.length > 0);

  return (
    <div className="flex flex-col gap-3">
      {urgent.length > 0 && (
        <div className="flex flex-col gap-2 rounded-[calc(12px*var(--admin-radius-scale,1))] bg-(--admin-accent)/[0.06] px-4 py-3 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--admin-accent)_18%,transparent)]">
          <p className="text-[13px] text-ink/75">
            {t("extensions.upgradeBanner", { names: urgent.map((e) => e.name).join("、") })}
          </p>
          <div className="flex flex-wrap gap-2">
            {urgent.map((e) => (
              <button
                key={e.id}
                type="button"
                disabled={pending !== null}
                onClick={() => runWithProgress(e)}
                className="inline-flex h-8 items-center gap-1.5 rounded-[calc(8px*var(--admin-radius-scale,1))] bg-ink px-3 text-[12.5px] font-medium text-white transition-[background-color,transform] duration-150 hover:bg-ink/85 active:scale-[0.96] disabled:opacity-45"
              >
                <CircleArrowUp aria-hidden className="size-3.5" />
                {urgent.length > 1 ? `${t("extensions.upgrade")} · ${e.name}` : t("extensions.upgrade")}
              </button>
            ))}
          </div>
        </div>
      )}

      {progress && (
        <EnableProgressCard state={progress} onClose={() => setProgress(null)} />
      )}

      {error && (
        <p
          role="alert"
          className="rounded-[calc(8px*var(--admin-radius-scale,1))] border border-red-600/15 bg-red-50 px-3 py-2 text-[13px] text-red-700"
        >
          {error}
        </p>
      )}

      <CoreTable
        columns={columns}
        rows={rows}
        rowKey={(e) => e.id}
        onRowClick={(e) => openSheet(e.id, false)}
        rowActive={(e) => open?.id === e.id && openExt !== null}
        trailingLabel={t("extensions.actions")}
        trailingActions={(e) => (
          <>
            {e.enabled && e.upgrade && (
              <RowIconButton
                label={t("extensions.upgrade")}
                onClick={() => {
                  if (pending === null) runWithProgress(e);
                }}
              >
                <CircleArrowUp className="size-3.5" />
              </RowIconButton>
            )}
            <RowIconButton
              label={e.enabled ? t("extensions.disable") : t("extensions.enable")}
              onClick={() => {
                if (pending === null)
                  run(e.id, e.enabled ? "disable" : "enable", e.kind);
              }}
            >
              {pending === `${e.id}:enable` || pending === `${e.id}:disable` ? (
                <span className="text-[12px]">…</span>
              ) : (
                <Power className="size-3.5" />
              )}
            </RowIconButton>
            {e.installed && (
              <RowIconButton
                label={t("extensions.uninstall")}
                danger
                onClick={() => openSheet(e.id, true)}
              >
                <Trash2 className="size-3.5" />
              </RowIconButton>
            )}
          </>
        )}
      />

      {/* 常駐 mount:open 切換才有進退場動畫(見 ExtensionSheet 註解)。 */}
      <ExtensionSheet
        request={
          open && openExt
            ? { ext: openExt, confirm: open.confirm, seq: open.seq }
            : null
        }
        pending={pending}
        onClose={() => setOpen(null)}
        onAction={(id, action, kind, purgeContent) =>
          run(id, action, kind, purgeContent)
        }
      />
    </div>
  );
}

export function ExtensionsManager({ extensions }: ExtensionsManagerProps) {
  const t = useT();
  // The Shop sidebar group deep-links here: "Browse store" → ?tab=browse,
  // "Installed" → no tab. The URL is the tab state: both sidebar links are the
  // same route, so a copy seeded once in useState never saw the second click.
  // In-page tabs write the URL with history.pushState, which Next syncs into
  // useSearchParams without a server round trip (and the sidebar highlight follows).
  const searchParams = useSearchParams();
  const tab: Tab = searchParams.get("tab") === "browse" ? "browse" : "installed";
  const setTab = (next: Tab) => {
    if (next === tab) return;
    const params = new URLSearchParams(searchParams.toString());
    if (next === "browse") params.set("tab", "browse");
    else params.delete("tab");
    const query = params.toString();
    window.history.pushState(null, "", query ? `?${query}` : window.location.pathname);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1 border-b">
        <button
          type="button"
          onClick={() => setTab("installed")}
          className={cn(
            "px-3 py-2 text-sm font-medium transition-colors",
            tab === "installed"
              ? "border-b-2 border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t("extensions.installed")} <NumberFlow value={extensions.length} />
        </button>
        <button
          type="button"
          onClick={() => setTab("browse")}
          className={cn(
            "px-3 py-2 text-sm font-medium transition-colors",
            tab === "browse"
              ? "border-b-2 border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t("extensions.browse")}
        </button>
        <DevInstallTrigger />
      </div>
      {tab === "installed" ? (
        <InstalledTab extensions={extensions} />
      ) : (
        <RegistryBrowser />
      )}
    </div>
  );
}
