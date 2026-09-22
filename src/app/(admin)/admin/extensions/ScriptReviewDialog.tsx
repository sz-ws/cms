"use client";

import { useMemo, useState } from "react";
import { AlertCircle, Check, ChevronDown, Code2, Copy, Globe, Loader2, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useLocale, useT } from "@/lib/i18n/I18nProvider";
import { cn } from "@/lib/utils";
import { allScriptRefs, scriptHosts, type DeclarativeScript } from "@/ext/dx/scripts";
import { buildScriptReviewPrompt } from "./script-review";

// 1.48.0:宣告式插件插入 script 前的核准,兩步:
//   1 看內容:一句話講清楚核准代表什麼,下面就是程式本身;要的話交給 AI 看一遍
//   2 確認:輸入插件 id —— 不是再按一次「確定」,是要真的停下來打字
// 安裝(useInstallFlow)、開發模式的 From JSON、已安裝插件的重新啟用(ExtensionScripts)
// 共用這一個。畫面刻意只放程式本身:設定值是管理員自己填的,不是要審的東西。

export interface ScriptReviewDialogProps {
  extensionId: string;
  extensionName: string;
  scripts: DeclarativeScript[];
  confirmLabel: string;
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

type AiState =
  | { kind: "idle" }
  | { kind: "copied" }
  | { kind: "copyFailed" }
  | { kind: "asking" }
  | { kind: "answer"; text: string }
  | { kind: "notConfigured" }
  | { kind: "failed"; error: string };

const CODE_BOX =
  "rounded-[calc(8px*var(--admin-radius-scale,1))] bg-ink/[0.035] px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-ink/75 [overflow-wrap:anywhere]";

/** 程式碼大小(UTF-8 位元組):未滿 1 KB 寫 B,其餘寫到小數一位的 KB。 */
function formatSize(code: string): string {
  const bytes = new TextEncoder().encode(code).length;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function ScriptReviewDialog({
  extensionId,
  extensionName,
  scripts,
  confirmLabel,
  submitting,
  error,
  onCancel,
  onConfirm,
}: ScriptReviewDialogProps) {
  const t = useT();
  const locale = useLocale();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [ai, setAi] = useState<AiState>({ kind: "idle" });
  // 程式碼預設收起:大多數人不會自己讀,要看的人按一下就展開。
  const [openCode, setOpenCode] = useState<number | null>(null);

  const hosts = useMemo(() => scriptHosts(scripts), [scripts]);
  // 設定值是管理員自己填的不列;內容與 feed 是這段程式拿得到的資料,要讓人看見。
  const dataRefs = useMemo(
    () => allScriptRefs(scripts).filter((r) => r.ns !== "settings").map((r) => r.path),
    [scripts],
  );
  const prompt = useMemo(
    () => buildScriptReviewPrompt({ extensionName, scripts, locale }),
    [extensionName, scripts, locale],
  );
  const confirmed = typed.trim() === extensionId;

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setAi({ kind: "copied" });
    } catch {
      setAi({ kind: "copyFailed" });
    }
  }

  async function askAssistant() {
    setAi({ kind: "asking" });
    try {
      const res = await fetch("/api/ai/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt }],
          maxTokens: 1500,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        text?: string;
        error?: string;
      };
      if (body.ok && body.text) {
        setAi({ kind: "answer", text: body.text });
      } else if (body.error === "not_configured") {
        setAi({ kind: "notConfigured" });
      } else {
        setAi({ kind: "failed", error: body.error ?? `HTTP ${res.status}` });
      }
    } catch (e) {
      setAi({ kind: "failed", error: e instanceof Error ? e.message : "network error" });
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!confirming) {
      setConfirming(true);
      return;
    }
    if (confirmed && !submitting) onConfirm();
  }

  const aiNote =
    ai.kind === "copied"
      ? t("scripts.copied")
      : ai.kind === "notConfigured"
        ? t("scripts.aiNotConfigured")
        : null;
  const aiError =
    ai.kind === "copyFailed"
      ? t("scripts.copyFailed")
      : ai.kind === "failed"
        ? t("scripts.aiFailed", { error: ai.error })
        : null;

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onCancel()}>
      <DialogContent className="max-w-lg rounded-[calc(20px*var(--admin-radius-scale,1))] p-0 shadow-[var(--admin-shadow-panel,0_16px_48px_-12px_rgba(30,20,50,0.18))]">
        <form onSubmit={handleSubmit} className="flex max-h-[85vh] flex-col gap-4 p-5">
          <DialogHeader>
            <DialogTitle>{t("scripts.title", { name: extensionName })}</DialogTitle>
            <DialogDescription className="text-[13px] leading-relaxed text-ink/55">
              {t("scripts.lead")}
            </DialogDescription>
          </DialogHeader>

          {!confirming ? (
            <div className="-mx-5 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5">
              <ul className="flex flex-col divide-y divide-ink/[0.06] rounded-[calc(10px*var(--admin-radius-scale,1))] border border-ink/[0.08]">
                {scripts.map((script, i) =>
                  script.src !== undefined ? (
                    <li key={i} className="flex items-start gap-2.5 px-3 py-2.5">
                      <Globe aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ink/40" />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="font-mono text-[12px] text-ink/75 [overflow-wrap:anywhere]">{script.src}</span>
                        <span className="text-[11px] text-ink/40">
                          {t("scripts.externalNote", { host: new URL(script.src).host })}
                        </span>
                      </span>
                    </li>
                  ) : (
                    <li key={i} className="flex flex-col">
                      <button
                        type="button"
                        aria-expanded={openCode === i}
                        onClick={() => setOpenCode(openCode === i ? null : i)}
                        className="flex items-center gap-2.5 px-3 py-2.5 text-left text-[12.5px] text-ink/70 transition-colors hover:bg-ink/[0.03]"
                      >
                        <Code2 aria-hidden className="size-3.5 shrink-0 text-ink/40" />
                        <span className="flex-1">
                          {t("scripts.inlineSummary", { size: formatSize(script.inline ?? "") })}
                        </span>
                        <span className="text-[12px] text-ink/45">
                          {openCode === i ? t("scripts.hideCode") : t("scripts.showCode")}
                        </span>
                        <ChevronDown
                          aria-hidden
                          className={cn("size-3.5 text-ink/35 transition-transform", openCode === i && "rotate-180")}
                        />
                      </button>
                      {openCode === i && (
                        <pre className={cn(CODE_BOX, "mx-3 mb-3 max-h-56 overflow-auto whitespace-pre-wrap")}>
                          {script.inline}
                        </pre>
                      )}
                    </li>
                  ),
                )}
              </ul>
              {(hosts.length > 0 || dataRefs.length > 0) && (
                <div className="flex flex-col gap-0.5 text-[12px] text-ink/45">
                  {hosts.length > 0 && (
                    <p>{t("scripts.connects", { hosts: hosts.join(locale === "zh-Hant" ? "、" : ", ") })}</p>
                  )}
                  {dataRefs.length > 0 && (
                    <p>{t("scripts.reads", { refs: dataRefs.join(locale === "zh-Hant" ? "、" : ", ") })}</p>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5 border-t border-ink/[0.06] pt-3">
                <Button type="button" variant="ghost" size="sm" className="gap-1.5 text-ink/60" onClick={() => void copyPrompt()}>
                  {ai.kind === "copied" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {t("scripts.copy")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-ink/60"
                  disabled={ai.kind === "asking"}
                  onClick={() => void askAssistant()}
                >
                  {ai.kind === "asking" ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                  {ai.kind === "asking" ? t("scripts.asking") : t("scripts.ask")}
                </Button>
                {aiNote && <span className="text-[12px] text-ink/45">{aiNote}</span>}
                {aiError && <span className="text-[12px] text-red-600">{aiError}</span>}
              </div>
              {ai.kind === "answer" && (
                <div className="flex flex-col gap-1.5">
                  <div className="max-h-64 overflow-auto rounded-[calc(10px*var(--admin-radius-scale,1))] border border-ink/[0.08] px-3.5 py-3 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink/75">
                    {ai.text}
                  </div>
                  <span className="text-[11px] text-ink/40">{t("scripts.aiCaveat")}</span>
                </div>
              )}
            </div>
          ) : (
            <label className="flex flex-col gap-2">
              <span className="text-[13px] text-ink/70">{t("scripts.confirmLead", { id: extensionId })}</span>
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={extensionId}
                autoComplete="off"
                spellCheck={false}
                autoFocus
                disabled={submitting}
                className="font-mono text-[13px]"
              />
              <span className="text-[12px] leading-relaxed text-ink/40">{t("scripts.confirmNote")}</span>
            </label>
          )}

          {error && (
            <div className="flex items-center gap-2 rounded-[calc(8px*var(--admin-radius-scale,1))] bg-red-50 px-3 py-2 text-[13px] text-red-700">
              <AlertCircle className="size-4 shrink-0" />
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              onClick={confirming ? () => setConfirming(false) : onCancel}
              disabled={submitting}
            >
              {confirming ? t("scripts.back") : t("scripts.cancel")}
            </Button>
            <Button type="submit" disabled={confirming && (!confirmed || submitting)} className="gap-1.5">
              {confirming && submitting && <Loader2 className="size-3.5 animate-spin" />}
              {confirming ? confirmLabel : t("scripts.next")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
