"use client";

import { Check, Circle, Loader2, Minus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";
import type { EnableStepEvent } from "@/ext/manager";

// 1.45.0:啟用／套用更新的進度卡。後台一步打一次 PATCH /api/extensions/<id>
// (action "enable-step"),每一步開始與結束都套一個 EnableStepEvent 到清單上:
// 等待中、進行中、完成、略過、失敗,失敗的那一步旁邊寫原因。

export type StepStatus = "waiting" | "running" | "done" | "skipped" | "failed";

export interface ProgressStep {
  /** check / migrate / migrate:<id> / settings / record */
  key: string;
  status: StepStatus;
  migration?: string;
  count?: number;
}

export interface EnableProgressState {
  extId: string;
  name: string;
  /** 有值 = 套用更新(已啟用的 extension 再 enable 一次)。 */
  upgrade?: { from: string; to: string };
  steps: ProgressStep[];
  outcome: "running" | "done" | "failed";
  error?: string;
}

/** 起始清單。套用更新時已知要跑哪些 migration,一個一步;全新啟用時先放一步「更新資料表」。 */
export function initialSteps(migrations: readonly string[] | null): ProgressStep[] {
  const migrate: ProgressStep[] = migrations?.length
    ? migrations.map((id) => ({ key: `migrate:${id}`, status: "waiting", migration: id }))
    : [{ key: "migrate", status: "waiting" }];
  return [
    { key: "check", status: "waiting" },
    ...migrate,
    { key: "settings", status: "waiting" },
    { key: "record", status: "waiting" },
  ];
}

/**
 * 換成伺服器這一刻說要跑的 migration(頁面載入後可能已有人先套用了幾個)。
 * 沒有要跑的就留一列佔位,之後標成「資料表已是最新」。
 */
export function withMigrations(steps: readonly ProgressStep[], ids: readonly string[]): ProgressStep[] {
  const rest = steps.filter((s) => s.key !== "migrate" && !s.key.startsWith("migrate:"));
  const rows: ProgressStep[] = ids.length
    ? ids.map((id) => ({ key: `migrate:${id}`, status: "waiting", migration: id }))
    : [{ key: "migrate", status: "waiting" }];
  const at = rest.findIndex((s) => s.key === "settings");
  return [...rest.slice(0, at), ...rows, ...rest.slice(at)];
}

/** 套一個步驟事件到清單上(純函式,回新陣列)。 */
export function applyStepEvent(steps: readonly ProgressStep[], event: EnableStepEvent): ProgressStep[] {
  if (event.step === "migrate" && event.migration) {
    const key = `migrate:${event.migration}`;
    const status: StepStatus = event.status === "done" ? "done" : "running";
    if (steps.some((s) => s.key === key)) {
      return steps.map((s) => (s.key === key ? { ...s, status } : s));
    }
    // 全新啟用:把佔位的「更新資料表」換成實際的 migration,依序排在 settings 前面。
    const withoutPlaceholder = steps.filter((s) => s.key !== "migrate");
    const at = withoutPlaceholder.findIndex((s) => s.key === "settings");
    const row: ProgressStep = { key, status, migration: event.migration };
    return [...withoutPlaceholder.slice(0, at), row, ...withoutPlaceholder.slice(at)];
  }
  if (event.step === "migrate") {
    // skipped:沒有要跑的 migration。
    return steps.map((s) => (s.key === "migrate" || s.key.startsWith("migrate:") ? { ...s, status: "skipped" } : s));
  }
  return steps.map((s) =>
    s.key === event.step
      ? { ...s, status: event.status === "running" ? "running" : event.status === "skipped" ? "skipped" : "done", count: event.count ?? s.count }
      : s,
  );
}

/**
 * 卡片上畫的列:每個 migration 各自是一步(一次一個請求、失敗從那一個重來),但畫出來
 * 合成一列「更新資料表」。migration id(0002_xxx)是寫給開發者的,店主看了只會困惑;
 * 要查是哪一個,伺服器 log 與 ext_migrations 表都有。
 */
export function receiptSteps(steps: readonly ProgressStep[]): ProgressStep[] {
  const at = steps.findIndex((s) => s.migration);
  if (at < 0) return [...steps];
  const statuses = steps.filter((s) => s.migration).map((s) => s.status);
  const status: StepStatus = statuses.includes("failed")
    ? "failed"
    : statuses.every((s) => s === "waiting")
      ? "waiting"
      : statuses.every((s) => s === "skipped")
        ? "skipped"
        : statuses.every((s) => s === "done" || s === "skipped")
          ? "done"
          : "running";
  return [...steps.slice(0, at), { key: "migrate", status }, ...steps.slice(at).filter((s) => !s.migration)];
}

/** 失敗時:進行中的那一步標成失敗;若還沒開始任何一步,就是第一步失敗。 */
export function markFailed(steps: readonly ProgressStep[]): ProgressStep[] {
  const running = steps.findIndex((s) => s.status === "running");
  const at = running >= 0 ? running : steps.findIndex((s) => s.status === "waiting");
  return steps.map((s, i) => (i === at ? { ...s, status: "failed" } : s));
}

function StepIcon({ status }: { status: StepStatus }) {
  const base = "size-3.5 shrink-0";
  if (status === "running") return <Loader2 aria-hidden className={cn(base, "animate-spin text-(--admin-accent)")} />;
  if (status === "done") return <Check aria-hidden className={cn(base, "text-[rgb(18,124,88)]")} />;
  if (status === "failed") return <X aria-hidden className={cn(base, "text-red-600")} />;
  if (status === "skipped") return <Minus aria-hidden className={cn(base, "text-ink/30")} />;
  return <Circle aria-hidden className={cn(base, "text-ink/20")} />;
}

export function EnableProgressCard({
  state,
  onClose,
}: {
  state: EnableProgressState;
  onClose: () => void;
}) {
  const t = useT();

  function label(step: ProgressStep): string {
    if (step.key === "check") return t("extensions.progress.check");
    if (step.key === "migrate") {
      return step.status === "skipped" ? t("extensions.progress.migrateSkipped") : t("extensions.progress.migrate");
    }
    if (step.key === "settings") {
      if (step.status !== "done") return t("extensions.progress.settings");
      return step.count
        ? t("extensions.progress.settingsAdded", { count: String(step.count) })
        : t("extensions.progress.settingsNone");
    }
    return t("extensions.progress.record");
  }

  const rows = receiptSteps(state.steps);
  const failedStep = rows.find((s) => s.status === "failed");
  const title =
    state.outcome === "failed"
      ? t("extensions.progress.failed", { name: state.name, step: failedStep ? label(failedStep) : "" })
      : state.outcome === "done"
        ? state.upgrade
          ? t("extensions.progress.upgraded", { name: state.name, to: state.upgrade.to })
          : t("extensions.progress.enabled", { name: state.name })
        : state.upgrade
          ? t("extensions.progress.upgrading", { name: state.name, from: state.upgrade.from, to: state.upgrade.to })
          : t("extensions.progress.enabling", { name: state.name });

  return (
    <section
      aria-live="polite"
      className={cn(
        "rounded-[calc(12px*var(--admin-radius-scale,1))] bg-surface px-4 py-3.5 shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04))]",
        state.outcome === "failed" && "shadow-[0_0_0_1px_rgba(220,38,38,0.2),0_1px_2px_-1px_rgba(0,0,0,0.06)]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13.5px] font-medium text-ink/85">{title}</p>
        {state.outcome !== "running" && (
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-[calc(6px*var(--admin-radius-scale,1))] px-2 py-0.5 text-[12px] text-ink/45 transition-colors hover:bg-ink/[0.04] hover:text-ink/75"
          >
            {t("extensions.progress.close")}
          </button>
        )}
      </div>
      <ol className="mt-2.5 flex flex-col gap-1.5">
        {rows.map((step) => (
          <li
            key={step.key}
            className={cn(
              "flex items-center gap-2 text-[12.5px]",
              step.status === "waiting" || step.status === "skipped" ? "text-ink/40" : "text-ink/75",
              step.status === "failed" && "text-red-700",
            )}
          >
            <StepIcon status={step.status} />
            <span>{label(step)}</span>
          </li>
        ))}
      </ol>
      {state.outcome === "failed" && (
        <div className="mt-2.5 flex flex-col gap-1 text-[12.5px]">
          {state.error && <p className="text-red-700">{state.error}</p>}
          <p className="text-ink/45">{t("extensions.progress.retryNote")}</p>
        </div>
      )}
    </section>
  );
}
