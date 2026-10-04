"use client";

import { motion, useReducedMotion } from "motion/react";
import { Check, Minus, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";
import { RingDot } from "@/components/admin/dashboard/RingDot";
import type { AgentProposal } from "@/ext/agent-loop";
import type { AgentPreview, AgentPreviewLine } from "@/ext/agent-preview";
import type { ProposalOutcome, ProposalResolution } from "./transcript";
import { flattenArgs } from "./args";
import { toolLeaf, toolNamespace } from "./tools";

// docs/spec-admin-agent.md §5:**確認卡是整個 UX 的核心 surface**。
//
// 它承載 spec §1.2 那條不可協商的規則:每個 write 動作都要人工確認,而且沒有跳過
// 的選項。因此這張卡的設計目標不是「好看」,是**讓人看得懂自己在批准什麼**:
//
//   · 模型自己的說法在卡片**上方**(由 AgentPanel 以一般助理訊息渲染),不在卡裡
//     —— 卡裡的每一個字都必須是 server 推導出來的事實,混進 LLM 生成的句子會讓
//     admin 分不清哪一句可信。
//   · summary 由 server 從 tool description 推導(agent-loop 的 proposalSummary),
//     不是模型寫的。
//   · 參數表逐列攤開真正會送出去的 args(args.ts),而不是一團 JSON。
//
// 視覺沿 docs/admin-design-language.md:20px shell → 14px 卡 → 8px 控制項的同心
// 圓角,shadow 而非 border 造層次,右對齊的表單動作列,主動作黑底白字。
//
// 動效紅線(CLAUDE.md,再次確認):**沒有任何 pulsing / ping / 呼吸光暈**。等待中
// 的狀態是靜態的 RingDot 加一句文字,不是會跳動的點。進場只有一次 opacity + y 的
// 位移(compositor-friendly),且 prefers-reduced-motion 時直接關掉。

interface ProposalCardProps {
  proposal: AgentProposal;
  resolution: ProposalResolution;
  outcome?: ProposalOutcome;
  /** 這張卡的 /execute 正在進行中。 */
  running: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 動作列按鈕:黑底主動作 / 白底次動作,同 8px 圓角、同 h-9(admin 表單語彙)。 */
function actionClasses(tone: "primary" | "secondary"): string {
  return cn(
    "inline-flex h-9 items-center gap-1.5 rounded-[calc(8px*var(--admin-radius-scale,1))] px-3.5 text-[13px] font-medium",
    "transition-[background-color,box-shadow,transform,opacity] duration-150 ease-out",
    "active:scale-[0.96] disabled:pointer-events-none disabled:opacity-45",
    tone === "primary"
      ? "bg-ink text-white hover:bg-ink/85"
      : "bg-surface text-ink/65 shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(20,18,22,0.07),0_1px_2px_-1px_rgba(20,18,22,0.06))] hover:text-ink/90",
  );
}

function ResolutionLine({
  resolution,
  outcome,
}: {
  resolution: ProposalResolution;
  outcome?: ProposalOutcome;
}) {
  const t = useT();
  if (resolution === "cancelled") {
    return (
      <p className="text-[12px] text-ink/40">{t("agent.proposal.cancelled")}</p>
    );
  }
  const ok = outcome?.ok ?? false;
  return (
    <div className="flex flex-col gap-1.5">
      <p
        className={cn(
          "flex items-center gap-1.5 text-[12px]",
          ok ? "text-ink/55" : "text-red-700",
        )}
      >
        {ok ? <Check className="size-3.5" /> : <X className="size-3.5" />}
        {ok ? t("agent.proposal.done") : t("agent.proposal.failed")}
      </p>
      {outcome?.detail && (
        <pre className="max-h-40 overflow-auto rounded-[calc(8px*var(--admin-radius-scale,1))] bg-ink/[0.035] px-2.5 py-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink/55">
          {outcome.detail}
        </pre>
      )}
    </div>
  );
}

/** 參數表:真正會送出去的 args,逐列攤開。 */
function ArgsTable({ args }: { args: unknown }) {
  const t = useT();
  const rows = flattenArgs(args);
  if (rows.length === 0) {
    return <p className="text-[12px] text-ink/35">{t("agent.proposal.noArgs")}</p>;
  }
  return (
    <dl className="flex flex-col divide-y divide-ink/[0.05] rounded-[calc(8px*var(--admin-radius-scale,1))] bg-ink/[0.02] px-2.5 py-1">
      {rows.map((row, index) => (
        <div
          key={`${row.key}-${index}`}
          className="flex items-baseline gap-3 py-1.5"
          style={{ paddingLeft: `${row.depth * 14}px` }}
        >
          <dt className="min-w-0 shrink-0 font-mono text-[11px] text-ink/45">{row.key}</dt>
          <dd className="min-w-0 flex-1 text-[12.5px] break-words text-ink/80">
            {row.value === null ? (
              <span className="text-[11px] text-ink/30">
                {row.hint === "truncated" ? "…" : `{${row.hint}}`}
              </span>
            ) : (
              row.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 預覽的一行。讀起來要像那篇內容本身:沒變的是淡的原文,加入的有底色與加號,移除的有
 * 刪除線與減號。顏色只用在「這一行會變」這件事上 —— 綠是多出來、紅是不見。
 */
function ChangeLine({ line }: { line: AgentPreviewLine }) {
  const t = useT();
  if (line.change === "gap") {
    return (
      <li className="px-2.5 py-1 text-[11.5px] text-ink/30">
        {t("agent.proposal.unchanged", { count: line.count })}
      </li>
    );
  }
  const added = line.change === "added";
  const removed = line.change === "removed";
  return (
    <li
      className={cn(
        "flex items-start gap-2 rounded-[calc(8px*var(--admin-radius-scale,1))] px-2.5 py-1.5",
        added && "bg-emerald-500/[0.08]",
        removed && "bg-red-500/[0.06]",
      )}
    >
      <span className="mt-[3px] flex size-3.5 shrink-0 items-center justify-center">
        {added && <Plus className="size-3.5 text-emerald-700" aria-label={t("agent.proposal.added")} />}
        {removed && <Minus className="size-3.5 text-red-700" aria-label={t("agent.proposal.removed")} />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {line.image && (
          // eslint-disable-next-line @next/next/no-img-element -- 站內檔案(/api/files/<key>),路徑已過 agentPreviewSchema。
          <img
            src={`${line.image}?w=640`}
            alt={line.text}
            loading="lazy"
            decoding="async"
            className={cn(
              "max-h-44 w-fit max-w-full rounded-[calc(6px*var(--admin-radius-scale,1))] object-contain",
              "outline outline-1 -outline-offset-1 outline-black/10",
              removed && "opacity-50",
            )}
          />
        )}
        {(line.text.length > 0 || !line.image) && (
          <p
            className={cn(
              "text-[12.5px] leading-relaxed break-words",
              line.heading && "font-medium",
              line.image && "text-[11.5px]",
              added ? "text-ink/85" : removed ? "text-ink/45 line-through decoration-ink/25" : "text-ink/45",
            )}
          >
            {line.text.length > 0 ? line.text : t("agent.proposal.emptyBlock")}
          </p>
        )}
      </div>
    </li>
  );
}

function ChangesPreview({ preview }: { preview: AgentPreview }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {preview.lines.map((line, index) => (
        <ChangeLine key={index} line={line} />
      ))}
    </ul>
  );
}

export function ProposalCard({
  proposal,
  resolution,
  outcome,
  running,
  onConfirm,
  onCancel,
}: ProposalCardProps) {
  const t = useT();
  const reduced = useReducedMotion();
  const pending = resolution === "pending";

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      // 同心圓角:20px halo → 14px 卡 → 8px 控制項(admin-design-language.md)。
      // halo 只給這一個 surface —— 它是這一頁唯一需要「停下來」的東西。
      className={cn(
        "w-full max-w-[36rem] rounded-[calc(20px*var(--admin-radius-scale,1))] p-1.5 backdrop-blur-md",
        pending
          ? "bg-surface/55 shadow-[var(--admin-shadow-panel,0_0_0_1px_rgba(0,0,0,0.05),0_16px_48px_-12px_rgba(30,20,50,0.18))]"
          : "bg-transparent",
      )}
    >
      <div
        className={cn(
          "flex flex-col gap-3.5 rounded-[calc(14px*var(--admin-radius-scale,1))] bg-surface p-4",
          "shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(20,18,22,0.055),0_1px_2px_-1px_rgba(20,18,22,0.06))]",
          !pending && "opacity-90",
        )}
      >
        <div className="flex items-center gap-2">
          {/* 靜態 ring-dot。等待中不閃、不跳、不呼吸 —— 見檔頭的動效紅線。 */}
          <RingDot accent={pending} />
          <span className="text-[11.5px] text-ink/40">
            {pending
              ? t("agent.proposal.heading")
              : resolution === "cancelled"
                ? t("agent.proposal.cancelled")
                : outcome?.ok
                  ? t("agent.proposal.done")
                  : t("agent.proposal.failed")}
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <p className="font-mono text-[11px] lowercase">
            <span className="text-ink/35">{toolNamespace(proposal.toolName)}.</span>
            <span className="text-ink/75">{toolLeaf(proposal.toolName)}</span>
          </p>
          <p className="text-[14px] leading-relaxed text-ink/85">
            {proposal.summary}
          </p>
        </div>

        {proposal.preview ? (
          <div className="flex flex-col gap-2">
            <p className="text-[11.5px] font-medium text-ink/45">{t("agent.proposal.changes")}</p>
            <ChangesPreview preview={proposal.preview} />
            {/* 參數還是看得到,只是收在後面:有預覽時,它不再是判斷的依據。 */}
            <details className="group">
              <summary className="w-fit cursor-pointer list-none text-[11.5px] text-ink/40 transition-colors duration-150 hover:text-ink/70">
                {t("agent.proposal.showArgs")}
              </summary>
              <div className="mt-1.5">
                <ArgsTable args={proposal.args} />
              </div>
            </details>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <p className="text-[11.5px] font-medium text-ink/45">{t("agent.proposal.args")}</p>
            <ArgsTable args={proposal.args} />
          </div>
        )}

        {pending ? (
          <>
            <p className="text-[11.5px] leading-relaxed text-ink/35">
              {t("agent.proposal.note")}
            </p>
            {/* 表單動作靠右,主動作最右(admin-design-language.md「Controls」)。 */}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                disabled={running}
                className={actionClasses("secondary")}
              >
                {t("agent.proposal.cancel")}
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={running}
                className={actionClasses("primary")}
              >
                {running ? t("agent.proposal.running") : t("agent.proposal.confirm")}
              </button>
            </div>
          </>
        ) : (
          <ResolutionLine resolution={resolution} outcome={outcome} />
        )}
      </div>
    </motion.div>
  );
}
