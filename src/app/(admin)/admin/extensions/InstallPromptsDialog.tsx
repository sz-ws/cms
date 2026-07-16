"use client";

import { useMemo, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Stepper, StepperList, StepperItem } from "@/components/ui/stepper";
import { cn } from "@/lib/utils";
import type { InstallPromptDef } from "./useInstallFlow";

// installPrompts 前門表單:manifest 宣告 installPrompts 時,Install/Get 先開這個
// Dialog 收值,再帶著 promptValues 打 /api/registry/install。純 UI 層,型別/
// required 驗證的最終真相仍在 server(validatePromptValues)。
//
// 當 manifest 宣告 ≥4 個 installPrompts,表單改用 vendored stepper 拆成每步最多 3
// 個欄位(最後一步放送出鈕),每步的 required 欄位填完才能 Next;≤3 個時維持原本
// 單一表單。這裡的 per-step required 檢查是 UX 前置攔截,server 仍會再驗一次。

const MAX_FIELDS_PER_STEP = 3;
const MULTI_STEP_THRESHOLD = 4;

interface InstallPromptsDialogProps {
  extensionName: string;
  prompts: InstallPromptDef[];
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (values: Record<string, unknown>) => void;
}

type FieldState = string | boolean;

function initialState(prompts: InstallPromptDef[]): Record<string, FieldState> {
  const state: Record<string, FieldState> = {};
  for (const p of prompts) state[p.key] = p.type === "boolean" ? false : "";
  return state;
}

/** 表單 state → 送出的 promptValues(見 useInstallFlow submitPrompts 的用途註解)。 */
function buildValues(
  prompts: InstallPromptDef[],
  state: Record<string, FieldState>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const p of prompts) {
    const raw = state[p.key];
    if (p.type === "boolean") {
      values[p.key] = Boolean(raw);
      continue;
    }
    if (p.type === "number") {
      if (typeof raw === "string" && raw.trim() !== "") {
        const n = Number(raw);
        if (Number.isFinite(n)) values[p.key] = n;
      }
      continue;
    }
    // text / textarea:非空一律送;required 且留空仍送出空字串,讓 server 的
    // missing_prompt_values 明確指出這個欄位(比默默套 default 更好懂)。
    if (typeof raw === "string" && raw.length > 0) {
      values[p.key] = raw;
    } else if (p.required) {
      values[p.key] = "";
    }
  }
  return values;
}

/** 一個 required 欄位是否已填(boolean 恆視為已填,它沒有「空」的狀態)。 */
function isFilled(p: InstallPromptDef, state: Record<string, FieldState>): boolean {
  if (p.type === "boolean") return true;
  const raw = state[p.key];
  return typeof raw === "string" && raw.trim() !== "";
}

/** 該步驟所有 required 欄位都填了才算完成(可以 Next / 送出)。 */
function stepComplete(
  fields: InstallPromptDef[],
  state: Record<string, FieldState>,
): boolean {
  return fields.every((p) => !p.required || isFilled(p, state));
}

/** ≥4 個 prompts → 每步最多 3 欄;否則整包當單一步驟。 */
function chunkPrompts(prompts: InstallPromptDef[]): InstallPromptDef[][] {
  if (prompts.length < MULTI_STEP_THRESHOLD) return [prompts];
  const steps: InstallPromptDef[][] = [];
  for (let i = 0; i < prompts.length; i += MAX_FIELDS_PER_STEP) {
    steps.push(prompts.slice(i, i + MAX_FIELDS_PER_STEP));
  }
  return steps;
}

export function InstallPromptsDialog({
  extensionName,
  prompts,
  submitting,
  error,
  onCancel,
  onSubmit,
}: InstallPromptsDialogProps) {
  const [state, setState] = useState<Record<string, FieldState>>(() =>
    initialState(prompts),
  );
  const steps = useMemo(() => chunkPrompts(prompts), [prompts]);
  const isMulti = steps.length > 1;
  const [stepIndex, setStepIndex] = useState(0);
  const [showErrors, setShowErrors] = useState(false);

  const currentFields = steps[stepIndex] ?? [];
  const isLastStep = stepIndex === steps.length - 1;
  const currentComplete = stepComplete(currentFields, state);

  function update(key: string, value: FieldState) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  function goToStep(next: number) {
    setShowErrors(false);
    setStepIndex(next);
  }

  function handleNext() {
    if (!currentComplete) {
      setShowErrors(true);
      return;
    }
    goToStep(Math.min(stepIndex + 1, steps.length - 1));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // 多步時最後一步同樣攔一次 required(單步維持原行為:交給 server 驗)。
    if (isMulti && !currentComplete) {
      setShowErrors(true);
      return;
    }
    onSubmit(buildValues(prompts, state));
  }

  function renderField(p: InstallPromptDef) {
    const invalid = showErrors && p.required && !isFilled(p, state);
    return (
      <div key={p.key} className="flex flex-col gap-1.5">
        <label className="text-[12px] font-medium text-black/55">
          {p.label}
          {p.required && <span className="ml-0.5 text-red-500">*</span>}
        </label>
        {p.description && (
          <p className="text-[11px] leading-relaxed text-black/40">
            {p.description}
          </p>
        )}
        {p.type === "textarea" ? (
          <Textarea
            value={String(state[p.key] ?? "")}
            onChange={(e) => update(p.key, e.target.value)}
            disabled={submitting}
            aria-invalid={invalid || undefined}
          />
        ) : p.type === "boolean" ? (
          <div className="flex h-9 items-center">
            <Switch
              checked={Boolean(state[p.key])}
              onCheckedChange={(checked) => update(p.key, checked)}
              disabled={submitting}
            />
          </div>
        ) : (
          <Input
            type={p.type === "number" ? "number" : p.secret ? "password" : "text"}
            value={String(state[p.key] ?? "")}
            onChange={(e) => update(p.key, e.target.value)}
            disabled={submitting}
            aria-invalid={invalid || undefined}
            className="font-mono text-[13px]"
          />
        )}
        {invalid && (
          <span className="text-[11px] text-red-600">This field is required.</span>
        )}
      </div>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onCancel()}>
      <DialogContent className="max-w-md rounded-[20px] p-0 shadow-[0_16px_48px_-12px_rgba(30,20,50,0.18)]">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-5">
          <DialogHeader>
            <DialogTitle>Set up {extensionName}</DialogTitle>
            <DialogDescription>
              {isMulti
                ? `Step ${stepIndex + 1} of ${steps.length} — a few values before install.`
                : "This extension needs a few values before it can be installed."}
            </DialogDescription>
          </DialogHeader>

          {isMulti && (
            <Stepper
              value={String(stepIndex)}
              steps={steps.map((_, i) => ({ value: String(i) }))}
              onValueChange={(v) => {
                const target = Number(v);
                // 只允許往回或當前步驟(往前的步驟已 disabled,setValue 也會擋)。
                if (Number.isFinite(target) && target <= stepIndex) {
                  goToStep(target);
                }
              }}
            >
              <StepperList>
                {steps.map((_, i) => (
                  <StepperItem
                    key={i}
                    value={String(i)}
                    completed={i < stepIndex}
                    disabled={i > stepIndex}
                  >
                    {`Step ${i + 1}`}
                  </StepperItem>
                ))}
              </StepperList>
            </Stepper>
          )}

          <div className="flex flex-col gap-3">
            {currentFields.map(renderField)}
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-[8px] bg-red-50 px-3 py-2 text-[13px] text-red-700">
              <AlertCircle className="size-4 shrink-0" />
              {error}
            </div>
          )}

          <div className="flex items-center gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={submitting}
              className={cn(isMulti ? "mr-auto" : "flex-1")}
            >
              Cancel
            </Button>

            {isMulti && stepIndex > 0 && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => goToStep(stepIndex - 1)}
                disabled={submitting}
              >
                Back
              </Button>
            )}

            {isMulti && !isLastStep ? (
              <Button type="button" onClick={handleNext} disabled={submitting}>
                Next
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={submitting}
                className={cn("gap-1.5", isMulti ? undefined : "flex-1")}
              >
                {submitting && <Loader2 className="size-3.5 animate-spin" />}
                {submitting ? "Installing…" : "Install"}
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
