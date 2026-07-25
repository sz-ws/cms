"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Label } from "@/components/ui/label";
import { Stepper, StepperItem, StepperList } from "@/components/ui/stepper";
import { StatusButton } from "@/components/ui/status-button";
import type { DeclarativeContentType, DeclarativeField } from "../manifest";
import { fieldLabel } from "./field-utils";
import { ExtLocaleProvider } from "../ext-locale";
import type { Locale } from "@/lib/i18n/index";
import { getMessages, format } from "@/lib/i18n/index";
import { FIELD_COMPONENTS } from "../fields";
import { getFieldComponent } from "../fields";
import type { ErasedFieldComponentProps } from "../fields";
import { SlugField } from "../fields/SlugField";
import { toFieldValue, buildFieldValue } from "../fields/field-values";
import { sameFieldValues } from "./form-dirty";
import { PublishScheduleControl } from "./PublishScheduleControl";
import { TextMorph } from "torph/react";

// core-v2 §3.3: generic declarative form client. Admin create/edit and public
// anonymous create now share the same field-rendering path (FIELD_COMPONENTS +
// field-values contract) instead of maintaining a second public-only form view.
//
// Admin mode:
//   - used by FormViewPage
//   - create / edit against auto-CRUD POST/PUT
//   - includes status + dirty guard + back navigation
//
// Public mode:
//   - used by publicRoutes view:"form"
//   - anonymous create against auto-CRUD POST on a public:true content type
//   - no status picker, no dirty guard, success message after submit
//   - only renders the safe public field subset (no media/relation/json/etc.)
//
// i18n (spec-extension-i18n.md §2.3): every user-visible string in this file comes
// from the core dictionary, looked up with `getMessages(props.locale)`. It CANNOT use
// useT()/useLocale() — public routes render outside core's I18nProvider — so the
// locale arrives as a prop, server-resolved by FormViewPage (admin) or
// PublicFormBody in interpret.tsx (public), exactly like the `locale` handed to
// ExtLocaleProvider below. This replaces the old `isPublic ? "中文" : "English"`
// ternaries, which picked a LANGUAGE by MODE and so were wrong on both sides
// (English site → Chinese public form; Chinese site → English admin form).
//
// Value contract: FieldValues holds each field's native stored shape
// (string | number | boolean | unknown for json), matching
// src/ext/dx/fields/types.ts FieldComponentProps — not the old
// all-strings-and-booleans FormState. date is epoch-ms number (see
// content-provider.ts + fields/DateField.tsx doc comment).

interface FormViewBaseProps {
  extId: string;
  typeName: string; // local content type name
  fields: DeclarativeField[];
  /** Content type's slugField (manifest.ts contentTypeSchema), wired down so
   * SlugField can auto-sync from the right source field's live value. */
  slugField?: string;
  /** spec-extension-i18n.md #4–#7:當前 locale。admin 由 FormViewPage server resolve、
   * public 由 PublicFormBody(interpret)resolve 後傳入;供 fieldLabel + 下放給整棵
   * field control 樹(ExtLocaleProvider),public 頁無 I18nProvider 亦可運作。 */
  locale: Locale;
}

export interface AdminFormViewProps extends FormViewBaseProps {
  mode?: "admin";
  backHref: string; // 儲存後導回列表
  initialId?: string;
  initialData?: Record<string, unknown>;
  initialStatus?: "draft" | "published";
  /** row 層排程發佈時戳(epoch ms;null = 未排程)。FormViewPage 從
   * getContentPublishAt 讀出;submit 時以 body.publishAt 流回 provider。 */
  initialPublishAt?: number | null;
  /** Progressive layout declaration from the manifest. Falls back to auto2col. */
  layout?: DeclarativeContentType["layout"];
}

interface PublicFormModeProps extends FormViewBaseProps {
  mode: "public";
  title: string;
  successMessage?: string;
  submitLabel?: string;
  /** 1.7.0:publicRoute `stepped` passthrough. ≥4 public-renderable fields → the
   * form splits into vendored Stepper steps of ≤3 (last step submits). <4 fields
   * or omitted → single form, unchanged. */
  stepped?: boolean;
}

export type FormViewProps = AdminFormViewProps | PublicFormModeProps;

type FieldValues = Record<string, unknown>;
type Messages = ReturnType<typeof getMessages>;

// AS.3: see the `dirty` state comment in FormView — outlasts RichtextEditor's
// own 300ms onChange debounce so its mount-time value normalisation never
// flips the unsaved-changes guard on by itself.
const MOUNT_GRACE_MS = 600;

const PUBLIC_CARD_SHADOW =
  "shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]";
const PUBLIC_SHELL_SHADOW =
  "shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_16px_48px_-12px_rgba(30,20,50,0.18)]";
const PUBLIC_FIELD_TYPES = new Set<DeclarativeField["type"]>([
  "text",
  "number",
  "boolean",
  "date",
  "select",
]);

function publicRenderableFields(fields: DeclarativeField[]): DeclarativeField[] {
  return fields.filter(
    (field) => !field.fields && !field.blocks && PUBLIC_FIELD_TYPES.has(field.type),
  );
}

// ---- stepped public forms (1.7.0) ----
// Mirrors InstallPromptsDialog's chunkPrompts/stepComplete approach (see
// src/app/(admin)/admin/extensions/InstallPromptsDialog.tsx): ≥4 fields → chunks
// of ≤3, last chunk submits; <4 fields → the whole set as a single "step" so the
// rest of the render path doesn't need a separate branch.
const MAX_STEP_FIELDS = 3;
const STEPPED_MIN_FIELDS = 4;

function chunkFields(fields: DeclarativeField[]): DeclarativeField[][] {
  if (fields.length < STEPPED_MIN_FIELDS) return [fields];
  const steps: DeclarativeField[][] = [];
  for (let i = 0; i < fields.length; i += MAX_STEP_FIELDS) {
    steps.push(fields.slice(i, i + MAX_STEP_FIELDS));
  }
  return steps;
}

/** A field counts as "filled" for step-gating purposes; boolean has no empty state. */
function isFieldFilled(field: DeclarativeField, values: FieldValues): boolean {
  if (field.type === "boolean") return true;
  const raw = values[field.key];
  if (raw === undefined || raw === null) return false;
  if (typeof raw === "string") return raw.trim().length > 0;
  if (typeof raw === "number") return Number.isFinite(raw);
  return true;
}

// Dirty compares two FieldValues maps by VALUE, not reference. Object/array-
// valued fields (richtext / group / repeater / blocks / relations / media) get
// re-emitted as deeply-equal-but-fresh references on mount (e.g. Tiptap's
// onUpdate normalisation) — a per-key `!==` mistook that for an edit and lit
// the unsaved-changes bar with nothing touched. sameFieldValues normalises both
// sides identically (empty ⇄ absent, empty Tiptap doc ⇄ nothing) then deep-
// compares, so a no-op re-emit is never dirty and Discard reliably clears it.
function sameState(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  return sameFieldValues(a, b);
}

/**
 * Status picker (admin mode) — 兩段式 paper & ink chip 切換器,取代原生 <select>。
 * Tab/Enter/Space/方向鍵 都能用(由 host element 自己負責)。
 */
type EntryStatus = "draft" | "published";

function StatusToggle({
  value,
  onChange,
  m,
}: {
  value: EntryStatus;
  onChange: (next: EntryStatus) => void;
  m: Messages;
}) {
  const options: EntryStatus[] = ["draft", "published"];
  const selectedIndex = options.indexOf(value);

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      onChange(options[(selectedIndex + 1) % options.length]);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      onChange(options[(selectedIndex - 1 + options.length) % options.length]);
    } else if (e.key === "Home") {
      e.preventDefault();
      onChange(options[0]);
    } else if (e.key === "End") {
      e.preventDefault();
      onChange(options[options.length - 1]);
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={m["extForm.admin.entryStatus"]}
      onKeyDown={onKey}
      className="inline-flex rounded-[10px] bg-black/[0.04] p-0.5"
    >
      {options.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(opt)}
            className={
              "inline-flex h-8 items-center rounded-[8px] px-3 text-[13px] font-medium transition-[background-color,color,box-shadow] duration-150 outline-none " +
              (active
                ? "bg-white text-black/85 shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_1px_2px_-1px_rgba(0,0,0,0.06)] focus-visible:shadow-[0_0_0_3px_rgba(86,114,228,0.35)]"
                : "text-black/55 hover:text-black/85 focus-visible:text-black/85 focus-visible:shadow-[0_0_0_3px_rgba(0,0,0,0.08)]")
            }
          >
            {opt === "draft"
              ? m["collection.filter.draft"]
              : m["collection.filter.published"]}
          </button>
        );
      })}
    </div>
  );
}

// Seed each field's editor value from stored data. Per-type normalisation lives
// in fields/field-values.ts (toFieldValue) so top-level fields AND nested
// group/repeater/blocks subfields share one contract (Tier 2 v1.2).
function toFieldValues(
  fields: DeclarativeField[],
  data: Record<string, unknown>,
): FieldValues {
  const state: FieldValues = {};
  for (const f of fields) state[f.key] = toFieldValue(f, data[f.key]);
  return state;
}

// spec-extension-i18n.md #4–#7:把整棵 field control 樹包在 ExtLocaleProvider 裡,
// 讓巢狀 client field control(LeafFieldControl / BlocksField / TextFullscreenEditor)
// 能經 useExtLocale() 取 locale——admin 與 public 兩種 mode 一致(public 頁無 core
// I18nProvider,故不能靠 useLocale())。
export function FormView(props: FormViewProps) {
  return (
    <ExtLocaleProvider locale={props.locale}>
      <FormViewInner {...props} />
    </ExtLocaleProvider>
  );
}

function FormViewInner(props: FormViewProps) {
  const router = useRouter();
  const isPublic = props.mode === "public";
  // 字典查表(public 頁無 I18nProvider,故不能用 useT();locale 由 prop 傳入)。
  const m = useMemo(() => getMessages(props.locale), [props.locale]);
  const fields = isPublic ? publicRenderableFields(props.fields) : props.fields;
  const initialData = isPublic ? {} : (props.initialData ?? {});
  const initialEntryStatus = isPublic
    ? "draft"
    : (props.initialStatus ?? "draft");
  const initialPublishAt = isPublic ? null : (props.initialPublishAt ?? null);
  const initialValues = useState<FieldValues>(() =>
    toFieldValues(fields, initialData),
  )[0];

  const initialValuesRef = useRef<FieldValues>(initialValues);
  const initialEntryStatusRef = useRef<"draft" | "published">(initialEntryStatus);
  const initialPublishAtRef = useRef<number | null>(initialPublishAt);
  const [values, setValues] = useState<FieldValues>(initialValues);
  const [entryStatus, setEntryStatus] = useState<"draft" | "published">(
    initialEntryStatus,
  );
  const [publishAt, setPublishAt] = useState<number | null>(initialPublishAt);
  const [submitState, setSubmitState] = useState<"idle" | "success">("idle");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showBar, setShowBar] = useState(false);
  const [honeypot, setHoneypot] = useState("");
  // 1.7.0: stepped public forms. Declared unconditionally (admin mode / non-stepped
  // public forms just never advance past step 0) so hook order stays stable.
  const [stepIndex, setStepIndex] = useState(0);
  const publicFormRef = useRef<HTMLFormElement | null>(null);
  const firstErrorRef = useRef<HTMLDivElement | null>(null);
  const readyRef = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => {
      readyRef.current = true;
    }, MOUNT_GRACE_MS);
    return () => clearTimeout(t);
  }, []);

  // Recompute dirty by comparing against the captured initial snapshot.
  // (RichtextEditor's 300ms on-change debounce can normalize on mount without
  // user input — the grace period before readiness absorbs that.)
  function recomputeDirty(
    nextValues: FieldValues,
    nextStatus: "draft" | "published",
    nextPublishAt: number | null,
  ): boolean {
    if (!readyRef.current) return false;
    if (!sameState(nextValues, initialValuesRef.current)) return true;
    if (nextStatus !== initialEntryStatusRef.current) return true;
    if (nextPublishAt !== initialPublishAtRef.current) return true;
    return false;
  }

  // Show-bar: dirty / pending / saved keep it visible; clean state retires it
  // 220ms after the last clean so it doesn't pop on entry. The immediate show
  // is a render-time "adjust state" (see UsersTable's prevInitial pattern) —
  // only the delayed hide needs the effect, and that setState happens async
  // inside the timeout callback, not synchronously.
  const barActive = dirty || pending || saved;
  if (barActive && !showBar) setShowBar(true);

  useEffect(() => {
    if (barActive) return;
    const t = window.setTimeout(() => setShowBar(false), 220);
    return () => window.clearTimeout(t);
  }, [barActive, isPublic]);

  const isEdit = !isPublic && Boolean(props.initialId);

  // AS.3: warn on tab close/reload while dirty. Public anonymous forms skip
  // this guard — they do not have an admin back-flow to protect.
  useEffect(() => {
    if (isPublic || !dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty, isPublic]);

  function confirmDiscard(): boolean {
    if (isPublic || !dirty) return true;
    return window.confirm(m["extForm.admin.discardConfirm"]);
  }

  function setField(key: string, value: unknown) {
    setValues((prev) => {
      const next = { ...prev, [key]: value };
      if (!isPublic) setDirty(recomputeDirty(next, entryStatus, publishAt));
      return next;
    });
  }

  function setEntryStatusDirty(next: "draft" | "published") {
    setEntryStatus(next);
    if (!isPublic) setDirty(recomputeDirty(values, next, publishAt));
  }

  function setPublishAtDirty(next: number | null) {
    setPublishAt(next);
    if (!isPublic) setDirty(recomputeDirty(values, entryStatus, next));
  }

  function resetToInitial() {
    setValues({ ...initialValuesRef.current });
    setEntryStatus(initialEntryStatusRef.current);
    setPublishAt(initialPublishAtRef.current);
    setDirty(false);
    setSaved(false);
    setError(null);
    setFieldErrors({});
  }

  // On save: mark current values as the new baseline so the bar retires, then
  // surface a short "Saved" affordance before navigating back. New entry ===
  // backHref so the workspace's collection list stays consistent.
  function markSavedAndNavigate() {
    initialValuesRef.current = { ...values };
    initialEntryStatusRef.current = entryStatus;
    // 存檔後的 baseline 用「實際送出」的值:Published 一律清排程(見 buildData)。
    initialPublishAtRef.current = entryStatus === "published" ? null : publishAt;
    setDirty(false);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1200);
    if (props.mode !== "public") {
      router.push(props.backHref);
      router.refresh();
    }
  }

  function buildData(): Record<string, unknown> | null {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = values[f.key];
      // Pre-submit guard for the two numeric types: a non-empty-but-unparseable
      // value should surface a friendly message rather than silently drop.
      if (
        (f.type === "number" || f.type === "date") &&
        raw !== undefined &&
        raw !== null &&
        raw !== "" &&
        !Number.isFinite(Number(raw))
      ) {
        setError(
          format(
            f.type === "number"
              ? m["extForm.error.mustBeNumber"]
              : m["extForm.error.mustBeDate"],
            { field: fieldLabel(f, props.locale) },
          ),
        );
        return null;
      }
      // Per-type shaping (incl. Tier 2 group/repeater/blocks) lives in
      // fields/field-values.ts. undefined = empty → omit (sparse doc).
      const built = buildFieldValue(f, raw);
      if (built !== undefined) out[f.key] = built;
    }
    if (!isPublic) {
      out.status = entryStatus;
      // row 層排程欄位(content-provider.ts extractPublishAt):admin 表單永遠帶
      // 明確值(number | null)以如實反映 UI 狀態;Published 沒有排程可言 → 清 null。
      out.publishAt = entryStatus === "published" ? null : publishAt;
    }
    if (isPublic && honeypot.length > 0) out._hp = honeypot;
    return out;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Stepped public forms: a native Enter-to-submit (or any submit before the
    // final step) re-runs the same required-fields gate as the Next button
    // instead of posting a partial payload (mirrors InstallPromptsDialog, where
    // only the final step's submit actually calls onSubmit).
    if (isPublic && isMultiStep && !isLastStep) {
      handleNextStep();
      return;
    }
    setError(null);
    setFieldErrors({});
    const data = buildData();
    if (!data) return;
    setPending(true);
    const url = isPublic
      ? `/api/ext/${props.extId}/${props.typeName}`
      : isEdit
        ? `/api/ext/${props.extId}/${props.typeName}/${encodeURIComponent(props.initialId!)}`
        : `/api/ext/${props.extId}/${props.typeName}`;
    const method = isPublic ? "POST" : isEdit ? "PUT" : "POST";
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        if (isPublic) {
          setSubmitState("success");
          return;
        }
        markSavedAndNavigate();
        return;
      }
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        message?: string;
        fields?: Record<string, string>;
      } | null;
      if (body?.error === "validation") {
        const errorFields = body.fields ?? {};
        setFieldErrors(errorFields);
        if (isPublic && isMultiStep) {
          // The errored field may live on an earlier, currently-hidden step —
          // jump there so its ref/inline message are actually visible (otherwise
          // firstErrorRef has nothing mounted to scroll to).
          const erroredKey = fields.find((f) => errorFields[f.key])?.key;
          const stepIdx = erroredKey
            ? fieldSteps.findIndex((step) => step.some((f) => f.key === erroredKey))
            : -1;
          if (stepIdx >= 0) goToStep(stepIdx);
        }
        setError(m["extForm.error.fixHighlighted"]);
      } else if (isPublic && res.status === 403) {
        setError(m["extForm.error.crossOrigin"]);
      } else if (isPublic && res.status === 429) {
        setError(m["extForm.error.tooManyRequests"]);
      } else {
        setError(
          isPublic
            ? m["extForm.error.submitFailed"]
            : m["extForm.error.saveFailed"],
        );
      }
    } catch {
      setError(m["extForm.error.network"]);
    } finally {
      setPending(false);
    }
  }

  // AS.3: after a validation error lands in state, scroll to + focus the
  // first invalid field's control (Tab/keyboard users still land inside the
  // control itself via the browser's native focus-follows-DOM order; this
  // ref just gets it into view).
  useEffect(() => {
    if (Object.keys(fieldErrors).length === 0) return;
    firstErrorRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    const input = firstErrorRef.current?.querySelector<HTMLElement>(
      "input, textarea, select, [contenteditable], button",
    );
    input?.focus();
  }, [fieldErrors]);

  const firstErrorKey = fields.find((f) => fieldErrors[f.key])?.key;

  // 1.7.0: stepped public forms (publicRoute `stepped`, see interpret.tsx). <4
  // fields or not stepped → chunkFields returns a single chunk, so isMultiStep
  // is false and every branch below behaves exactly as before this feature.
  const fieldSteps = isPublic && props.stepped ? chunkFields(fields) : [fields];
  const isMultiStep = fieldSteps.length > 1;
  const currentStepFields =
    fieldSteps[Math.min(stepIndex, fieldSteps.length - 1)] ?? fields;
  const isLastStep = stepIndex >= fieldSteps.length - 1;

  function goToStep(next: number) {
    setStepIndex(Math.max(0, Math.min(next, fieldSteps.length - 1)));
  }

  /** Advance a step only once its required fields are filled (UX pre-check —
   * server still re-validates on final submit). Blocks "next" otherwise. */
  function handleNextStep() {
    const missing = currentStepFields.filter(
      (f) => f.required && !isFieldFilled(f, values),
    );
    if (missing.length > 0) {
      setFieldErrors((prev) => {
        const next = { ...prev };
        for (const f of missing)
          next[f.key] = m["extForm.public.requiredField"];
        return next;
      });
      return;
    }
    goToStep(stepIndex + 1);
  }

  if (isPublic && submitState === "success") {
    return (
      <main className="mx-auto flex max-w-2xl flex-col px-6 py-12">
        <div
          className={`rounded-[20px] bg-white/55 p-1.5 backdrop-blur-md ${PUBLIC_SHELL_SHADOW}`}
        >
          <div className={`rounded-[14px] bg-white px-6 py-6 ${PUBLIC_CARD_SHADOW}`}>
            <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-black/90">
              {props.title}
            </h1>
            <p className="mt-2 text-[14px] leading-relaxed text-black/70">
              {props.successMessage ?? m["extForm.public.successDefault"]}
            </p>
          </div>
        </div>
      </main>
    );
  }

  if (isPublic) {
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
        <div
          className={`rounded-[20px] bg-white/55 p-1.5 backdrop-blur-md ${PUBLIC_SHELL_SHADOW}`}
        >
          <div className={`rounded-[14px] bg-white ${PUBLIC_CARD_SHADOW}`}>
            <div className="px-6 pt-6 pb-5">
              <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-black/90">
                {props.title}
              </h1>
              <p className="mt-0.5 text-[13px] text-black/45">
                {isMultiStep
                  ? format(m["extForm.public.stepOfTotal"], {
                      current: stepIndex + 1,
                      total: fieldSteps.length,
                    })
                  : // 訪客可見文案,不得出現內部行話(冷眼回報 2026-07-16)。
                    m["extForm.public.intro"]}
              </p>
            </div>

            <form
              ref={publicFormRef}
              onSubmit={onSubmit}
              className="flex flex-col gap-4 px-6 pb-6"
              noValidate
            >
              <input
                name="_hp"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                value={honeypot}
                onChange={(e) => setHoneypot(e.target.value)}
                className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden opacity-0 pointer-events-none"
              />

              {isMultiStep && (
                <Stepper
                  value={String(stepIndex)}
                  steps={fieldSteps.map((_, i) => ({ value: String(i) }))}
                  onValueChange={(v) => {
                    const target = Number(v);
                    // 只允許往回或當前步驟(往前的步驟已 disabled,setValue 也會擋)。
                    if (Number.isFinite(target) && target <= stepIndex) {
                      goToStep(target);
                    }
                  }}
                >
                  <StepperList>
                    {fieldSteps.map((_, i) => (
                      <StepperItem
                        key={i}
                        value={String(i)}
                        completed={i < stepIndex}
                        disabled={i > stepIndex}
                      >
                        {format(m["extForm.public.step"], { n: i + 1 })}
                      </StepperItem>
                    ))}
                  </StepperList>
                </Stepper>
              )}

              {currentStepFields.map((f) => (
                <div
                  key={f.key}
                  ref={f.key === firstErrorKey ? firstErrorRef : undefined}
                  className="flex flex-col gap-1.5"
                >
                  {f.type !== "boolean" && (
                    <Label
                      htmlFor={`field-${f.key}`}
                      className="text-[13px] font-medium text-black/55"
                    >
                      {fieldLabel(f, props.locale)}
                      {f.required && <span className="text-destructive"> *</span>}
                    </Label>
                  )}
                  <FieldControl
                    field={f}
                    value={values[f.key]}
                    onChange={(v) => setField(f.key, v)}
                    disabled={pending}
                    error={fieldErrors[f.key]}
                    sourceValue={
                      props.slugField
                        ? (values[props.slugField] as string | undefined)
                        : undefined
                    }
                  />
                  {f.type === "boolean" && (
                    <span className="sr-only">{fieldLabel(f, props.locale)}</span>
                  )}
                  {fieldErrors[f.key] && (
                    <p className="rounded-[8px] border border-red-600/15 bg-red-50 px-2.5 py-1.5 text-[13px] normal-case text-red-700">
                      {fieldErrors[f.key]}
                    </p>
                  )}
                </div>
              ))}

              {error && (
                <p className="rounded-[8px] border border-red-600/15 bg-red-50 px-3 py-2 text-[13px] text-red-700">
                  {error}
                </p>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                {isMultiStep && stepIndex > 0 && (
                  <button
                    type="button"
                    onClick={() => goToStep(stepIndex - 1)}
                    disabled={pending}
                    className="inline-flex h-10 items-center justify-center rounded-[8px] px-4 text-[14px] font-medium text-black/55 transition-colors duration-150 ease-out hover:bg-black/[0.04] hover:text-black/85 disabled:opacity-50"
                  >
                    {m["extForm.public.back"]}
                  </button>
                )}
                {isMultiStep && !isLastStep ? (
                  <button
                    type="button"
                    onClick={handleNextStep}
                    disabled={pending}
                    // 1.8.0:accent token tint(fallback 為現行黑色);radius 亦可被 token 覆寫。
                    style={{
                      background: "var(--ext-accent, #000)",
                      borderRadius: "var(--ext-radius, 8px)",
                    }}
                    className="inline-flex h-10 items-center justify-center gap-1.5 px-4 text-[14px] font-medium text-white shadow-[0_0_0_1px_rgba(0,0,0,0.08)] transition-[background-color,transform] duration-150 ease-out active:scale-[0.96] disabled:opacity-50"
                  >
                    {m["extForm.public.next"]}
                  </button>
                ) : (
                  // 送出鈕改用 vendored StatusButton(1.7.0),映射既有 pending/error 狀態;
                  // success 會整個 unmount 到上面的成功畫面,所以這裡不需要對映 "success"。
                  // StatusButton 本身固定 type="button",靠 requestSubmit() 觸發原本的
                  // <form onSubmit> 流程(而非重複一份提交邏輯)。
                  <StatusButton
                    status={pending ? "loading" : error ? "error" : "idle"}
                    label={
                      pending
                        ? m["extForm.public.submitting"]
                        : (props.submitLabel ?? m["extForm.public.submit"])
                    }
                    onClick={() => publicFormRef.current?.requestSubmit()}
                    // 1.8.0:accent token tint(fallback 為現行黑色實心)。
                    style={{ background: "var(--ext-accent, #000)" }}
                  />
                )}
              </div>
            </form>
          </div>
        </div>
      </main>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="grid max-w-3xl grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2"
    >
      {renderAdminFields({
        fields,
        layout: props.layout,
        values,
        setField,
        fieldErrors,
        firstErrorKey,
        pending,
        props,
        body: (
          <div className="col-span-full flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-black/55">
              {m["extForm.admin.status"]}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <StatusToggle
                value={entryStatus}
                onChange={setEntryStatusDirty}
                m={m}
              />
              {entryStatus === "draft" && (
                <PublishScheduleControl
                  value={publishAt}
                  onChange={setPublishAtDirty}
                  disabled={pending}
                />
              )}
            </div>
          </div>
        ),
        saveBar: (
          <div
            className={[
              "pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4 transition-[opacity,transform] duration-220 ease-out",
              showBar ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0",
            ].join(" ")}
          >
            <div className="pointer-events-auto w-full max-w-3xl rounded-[20px] bg-white/65 p-1.5 shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_16px_48px_-12px_rgba(30,20,50,0.18)] backdrop-blur-md">
              <div className="flex items-center justify-between gap-4 rounded-[14px] bg-white px-4 py-3 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[12px] font-medium text-black/45">
                    {/* 同位置狀態切換 → TextMorph(同 ExtensionsManager StatusPill)。 */}
                    <TextMorph respectReducedMotion>
                      {pending
                        ? m["extForm.admin.saving"]
                        : saved
                          ? m["extForm.admin.saved"]
                          : dirty
                            ? entryStatus === "draft" && publishAt !== null
                              ? m["extForm.admin.readyToSchedule"]
                              : m["extForm.admin.readyToSave"]
                            : m["extForm.admin.upToDate"]}
                    </TextMorph>
                  </span>
                  <span className="text-[11px] text-black/35">
                    {error ??
                      (saved
                        ? m["extForm.admin.changesApplied"]
                        : dirty
                          ? m["extForm.admin.unsavedChanges"]
                          : m["extForm.admin.noChanges"])}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (!confirmDiscard()) return;
                      resetToInitial();
                      router.push(props.backHref);
                    }}
                    disabled={!dirty}
                    className="inline-flex h-9 items-center rounded-[8px] px-3 text-[13px] font-medium text-black/55 transition-colors hover:bg-black/[0.03] hover:text-black/85 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {m["extForm.admin.discard"]}
                  </button>
                  <button
                    type="submit"
                    disabled={pending || !dirty}
                    className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[8px] bg-black pr-3 pl-3.5 text-[14px] font-medium text-white transition-[background-color,transform] duration-150 ease-out hover:bg-black/85 active:scale-[0.96] focus-visible:shadow-[0_0_0_3px_rgba(0,0,0,0.15)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <TextMorph respectReducedMotion>
                      {pending ? m["extForm.admin.saving"] : m["extForm.admin.save"]}
                    </TextMorph>
                    {!pending && (
                      <span aria-hidden className="text-white/70">→</span>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ),
      })}
    </form>
  );
}

interface FieldControlProps {
  field: DeclarativeField;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  /** Per-field validation message from the last submit's 400 response (see
   * onSubmit / ContentValidationError.fields); undefined when this field is
   * currently valid. Rendered by the field component itself (aria-invalid /
   * data-invalid) — FormView also renders the message below the control. */
  error?: string;
  /** Live value of the content type's slugField source (only used by
   * SlugField); undefined when this field isn't "slug" or no slugField is
   * configured on the content type. */
  sourceValue?: string;
}

function FieldControl({
  field,
  value,
  onChange,
  disabled,
  error,
  sourceValue,
}: FieldControlProps) {
  if (field.type === "slug") {
    return (
      <SlugField
        field={field}
        value={typeof value === "string" ? value : ""}
        onChange={onChange as (v: string) => void}
        error={error}
        disabled={disabled}
        sourceValue={sourceValue}
      />
    );
  }

  const Component = (getFieldComponent(field) ??
    FIELD_COMPONENTS[field.type]) as
    | React.ComponentType<ErasedFieldComponentProps>
    | undefined;

  if (!Component) {
    // Unknown/未支援型別:退回純文字輸入,避免整個表單當機。
    return (
      <input
        id={`field-${field.key}`}
        className="h-9 w-full rounded-3xl border border-input bg-input/50 px-3 text-sm"
        value={typeof value === "string" ? value : String(value ?? "")}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <Component
      field={field}
      value={value}
      onChange={onChange}
      disabled={disabled}
      error={error}
    />
  );
}

// ---- Progressive layout (declarative auto2col / single / manual) ----

/** Adaptive 2-col 的寬欄判斷:auto2col 的基準行為,將 multi-line / richtext /
 * media / 結構欄 / 寬型 widget 拆兩欄,大多數短欄位則維持單欄。 */
function isFullWidthField(field: DeclarativeField): boolean {
  const t: string = field.type;
  if (t === "richtext" || t === "media" || t === "group") return true;
  if (t === "repeater" || t === "blocks") return true;
  if (t === "json") return true;
  if (t === "slug") return true;
  if (t === "text" && field.multiline === true) return true;
  return false;
}

interface RenderAdminFieldsArgs {
  fields: DeclarativeField[];
  layout?: DeclarativeContentType["layout"];
  values: FieldValues;
  setField: (key: string, value: unknown) => void;
  fieldErrors: Record<string, string>;
  firstErrorKey: string | undefined;
  pending: boolean;
  props: AdminFormViewProps;
  body: React.ReactNode;
  saveBar: React.ReactNode;
}

/**
 * Progressive layout resolver for admin mode.
 * - kind = "auto2col" (default) → baseline: tall fields span full row, short fields pair.
 * - kind = "single"    → every field stack to one column at full width.
 * - kind = "manual"    → author-declared groups; each group is full-width or paired;
 *                          fields not listed in `layout.groups` always render
 *                          full-width, appended after the explicit groups.
 */
function renderAdminFields(args: RenderAdminFieldsArgs) {
  const kind = args.layout?.kind ?? "auto2col";
  const wide = args.layout?.kind === "manual" ? args.layout.wide ?? [] : [];
  const { fields, values, setField, fieldErrors, pending } = args;
  const props = args.props;
  const fieldByKey = new Map(fields.map((f) => [f.key, f]));

  function renderField(f: DeclarativeField, colSpanClass: string) {
    return (
      <div
        key={f.key}
        className={`flex min-w-0 flex-col gap-1.5 ${colSpanClass}`}
      >
        {f.type !== "boolean" && (
          <Label htmlFor={`field-${f.key}`}>
            {fieldLabel(f, props.locale)}
            {f.required && <span className="text-destructive"> *</span>}
          </Label>
        )}
        <FieldControl
          field={f}
          value={values[f.key]}
          onChange={(v) => setField(f.key, v)}
          disabled={pending}
          error={fieldErrors[f.key]}
          sourceValue={
            props.slugField
              ? (values[props.slugField] as string | undefined)
              : undefined
          }
        />
        {f.type === "boolean" && (
          <span className="sr-only">{fieldLabel(f, props.locale)}</span>
        )}
        {fieldErrors[f.key] && (
          <p className="rounded-[8px] border border-red-600/15 bg-red-50 px-2.5 py-1.5 text-[13px] normal-case text-red-700">
            {fieldErrors[f.key]}
          </p>
        )}
      </div>
    );
  }

  if (kind === "single") {
    return (
      <>
        <div className="col-span-full grid grid-cols-1 gap-y-4">
          {fields.map((f) => renderField(f, "col-span-full"))}
        </div>
        {args.body}
        {args.saveBar}
      </>
    );
  }

  if (kind === "manual") {
    const groups = args.layout?.groups ?? [];
    const seen = new Set<string>();
    const isWide = (k: string) => wide.includes(k);
    return (
      <>
        <div className="col-span-full flex flex-col gap-4">
          {groups.map((g, gi) => {
            const fullWidth = g.fullWidth || g.fields.length === 1;
            if (fullWidth) {
              return (
                <div key={`g-${gi}`} className="grid grid-cols-1 gap-y-4">
                  {g.fields.map((fk) => {
                    const f = fieldByKey.get(fk);
                    if (!f) return null;
                    seen.add(fk);
                    return renderField(f, "col-span-full");
                  })}
                </div>
              );
            }
            return (
              <div
                key={`g-${gi}`}
                className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2"
              >
                {g.fields.map((fk) => {
                  const f = fieldByKey.get(fk);
                  if (!f) return null;
                  seen.add(fk);
                  const colSpanClass = isWide(fk)
                    ? "col-span-full sm:col-span-2"
                    : "col-span-full sm:col-span-1";
                  return renderField(f, colSpanClass);
                })}
              </div>
            );
          })}
          {fields
            .filter((f) => !seen.has(f.key))
            .map((f) => renderField(f, "col-span-full"))}
        </div>
        {args.body}
        {args.saveBar}
      </>
    );
  }

  return (
    <>
      {fields.map((f) => {
        const wide = isFullWidthField(f);
        return renderField(
          f,
          wide ? "col-span-full" : "col-span-full sm:col-span-1",
        );
      })}
      {args.body}
      {args.saveBar}
    </>
  );
}
