"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SettingField } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Checkbox, Input, Textarea } from "../ui/legacy";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FluidTabs } from "@/components/ui/fluid-tabs";
import { EmailDomainChips } from "./EmailDomainChips";
import { ColorSwatchPicker } from "./ColorSwatchPicker";
import { SettingUnitHint } from "./SettingUnitHint";
import { SaveBar, SAVE_BUTTON_CLASS } from "./SaveBar";
import { SettingTabs } from "./SettingTabs";
import { useT, useLocale } from "@/lib/i18n/I18nProvider";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import { changedSettingEntries, settingControlId } from "@/lib/settings-ui";

export interface SettingsSection {
  id: string;
  title: string;
  /** 空/省略 → 卡片只出標題(未登記文案的 group 走這條)。 */
  description?: string;
  keyPrefix: string;
  fields: SettingField[];
}

interface SettingsWorkspaceProps {
  sections: SettingsSection[];
  values: Record<string, unknown>;
  coreAddon?: React.ReactNode;
  /** 額外欄位管理(核心分頁,自己一張卡、自己一個導覽錨點)。有自己的儲存鈕,不進這裡的表單。 */
  extraFieldsSection?: React.ReactNode;
  /** 「風格」分頁的內容(AdminThemeEditor)。有自己的儲存鈕,不進這裡的表單。 */
  styleTab?: React.ReactNode;
  /** 網址的 ?tab=,不認得的值回到核心。 */
  initialTab?: string;
}

type SettingsState = Record<string, string | boolean>;
type SettingsTab = "core" | "style" | "declarative" | "extensions";
const SETTINGS_TABS: readonly SettingsTab[] = ["core", "style", "declarative", "extensions"];

// 每一組設定是一張單層卡片(同角色頁與成員表格)。外面再包一圈玻璃框,
// 「細邊線」風格下兩層陰影都變成 1px 線,會畫成兩道邊。
const SECTION_CARD =
  "rounded-[calc(14px*var(--admin-radius-scale,1))] bg-surface px-6 pt-6 pb-5 shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04))]";

function resolveTab(value: string | undefined, hasStyle: boolean): SettingsTab {
  const tab = SETTINGS_TABS.find((id) => id === value) ?? "core";
  return tab === "style" && !hasStyle ? "core" : tab;
}

function initialValue(
  field: SettingField,
  values: Record<string, unknown>,
  keyPrefix: string,
): string | boolean {
  if (field.secret) return "";
  const fullKey = `${keyPrefix}${field.key}`;
  const v = values[fullKey];
  // 沒存過的欄位照預設值畫:以前布林欄位直接 Boolean(undefined),預設開著的
  // (robots / sitemap / RSS)在設定頁顯示成關著。
  const raw = v === undefined || v === null ? (field.default ?? "") : v;
  if (field.type === "boolean") return Boolean(raw);
  if (field.type === "textarea" && typeof raw !== "string") {
    return JSON.stringify(raw);
  }
  return String(raw);
}

function buildInitialState(
  sections: SettingsSection[],
  values: Record<string, unknown>,
): SettingsState {
  const init: SettingsState = {};
  for (const section of sections) {
    for (const field of section.fields) {
      init[`${section.keyPrefix}${field.key}`] = initialValue(
        field,
        values,
        section.keyPrefix,
      );
    }
  }
  return init;
}

function sameState(a: SettingsState, b: SettingsState): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

// 不寫成 type predicate:false 的那一邊還有一般下拉選單,不能把整個 select 型別排除掉。
function isTabs(field: SettingField): boolean {
  return field.type === "select" && field.presentation === "tabs";
}

function fieldWrapperClass(field: SettingField): string {
  // 分頁(1.44.0)佔整列:它決定下面出現哪些欄位,放半欄會跟旁邊的欄位混在一起。
  return field.type === "textarea" || isTabs(field)
    ? "col-span-full"
    : "col-span-full sm:col-span-1";
}

/** 1.56.0:一般輸入框的 type —— 數字、日期(text 的 format: "date"),其餘是文字。 */
function inputType(field: SettingField): "number" | "date" | "text" {
  if (field.type === "number") return "number";
  return field.type === "text" && field.format === "date" ? "date" : "text";
}

function labelClass(): string {
  return "text-[13px] font-medium text-ink/55";
}

function descriptionClass(): string {
  return "text-[12px] leading-relaxed text-ink/40";
}

/** core 分組卡的 id 慣例:`core-<group>`(見 settings/page.tsx)。 */
function isCoreSection(section: SettingsSection): boolean {
  return section.id.startsWith("core-");
}

/** anchor id 慣例:section.id 前面加 `section-` 前綴,避免跟其他頁面元素撞名。 */
function sectionAnchorId(id: string): string {
  return `section-${id}`;
}

// 快速導覽條的單一分頁:「正常」的底線切換樣式(對比上方 FluidTabs 的動畫藥丸),
// active 用站台唯一的 accent(dither blue)畫底線,不是又一組 pill。
function NavAnchor({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative shrink-0 whitespace-nowrap px-3 py-2.5 text-[13px] font-medium transition-colors",
        active ? "text-ink/90" : "text-ink/40 hover:text-ink/65",
      )}
    >
      {label}
      <span
        aria-hidden
        className={cn(
          "absolute inset-x-3 -bottom-px h-[2px] rounded-full transition-opacity duration-150",
          active ? "opacity-100" : "opacity-0",
        )}
        style={{ backgroundColor: "var(--admin-accent)" }}
      />
    </button>
  );
}

function visibleSections(
  sections: SettingsSection[],
  activeTab: SettingsTab,
): SettingsSection[] {
  if (activeTab === "core") {
    return sections.filter(isCoreSection);
  }
  if (activeTab === "extensions") {
    return sections.filter((section) => !isCoreSection(section));
  }
  return [];
}

// 伺服器回的欄位錯誤碼(lib/setting-validation.ts)→ 欄位下方那一行字。
function fieldErrorText(code: string, t: ReturnType<typeof useT>): string {
  if (code === "required") return t("settingsWorkspace.fieldRequired");
  if (code === "invalid_option") return t("settingsWorkspace.fieldInvalidOption");
  if (code === "expected_number") return t("settingsWorkspace.fieldExpectedNumber");
  if (code === "invalid_color") return t("settingsWorkspace.fieldInvalidColor");
  if (code === "too_long") return t("settingsWorkspace.fieldTooLong");
  if (code === "not_plain_text") return t("settingsWorkspace.fieldNotPlainText");
  if (code === "invalid_link") return t("settingsWorkspace.fieldInvalidLink");
  if (code === "invalid_date") return t("settingsWorkspace.fieldInvalidDate");
  return t("settingsWorkspace.fieldInvalid");
}

function statusLine(
  pending: boolean,
  saved: boolean,
  error: string | null,
  t: ReturnType<typeof useT>,
): { title: string; note: string } {
  if (pending) {
    return {
      title: t("settingsWorkspace.saving"),
      note: t("settingsWorkspace.savingNote"),
    };
  }
  if (error) {
    return { title: t("settingsWorkspace.saveFailed"), note: error };
  }
  if (saved) {
    return {
      title: t("settingsWorkspace.saved"),
      note: t("settingsWorkspace.savedNote"),
    };
  }
  return {
    title: t("settingsWorkspace.readyToSave"),
    note: t("settingsWorkspace.readyNote"),
  };
}

export function SettingsWorkspace({
  sections,
  values,
  coreAddon,
  extraFieldsSection,
  styleTab,
  initialTab,
}: SettingsWorkspaceProps) {
  const t = useT();
  // §1 #9–#11:extension settings 的 label/description/option.label 可為 LocalizedString;
  // admin 有 I18nProvider,故直接 useLocale() resolve(核心 settings 為純字串,原樣透傳)。
  const locale = useLocale();
  const coreAddonNode = coreAddon ?? null;
  const extraFieldsNode = extraFieldsSection ?? null;
  // fullKey → 伺服器回的錯誤碼;改動該欄位就清掉那一格的錯誤。
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Registry manager + API tokens:core tab 最後一張獨立卡(不塞進任何分組卡)。
  function renderCoreAddonSection() {
    if (!coreAddonNode) return null;
    return (
      <section
        key="core-addon"
        id={sectionAnchorId("core-addon")}
        className={cn("scroll-mt-20", SECTION_CARD)}
      >
        {coreAddonNode}
      </section>
    );
  }

  // 額外欄位:放在分組卡之後、來源與權杖之前 —— 它是「內容長什麼樣」的設定,
  // 跟上面的網站設定同一類,不該埋進來源與權杖那張卡。
  function renderExtraFieldsSection() {
    if (!extraFieldsNode) return null;
    return (
      <section
        key="extra-fields"
        id={sectionAnchorId("extra-fields")}
        className={cn("scroll-mt-20", SECTION_CARD)}
      >
        {extraFieldsNode}
      </section>
    );
  }

  function renderSectionFields(section: SettingsSection) {
    return (
      // 每個欄位佔三列(標題 / 輸入框 / 說明),用 subgrid 跟同一排的欄位共用列高:
      // 一邊有說明、一邊沒有,或標題折成兩行時,兩邊的輸入框仍然對齊。
      // 說明放在輸入框下面,沒有說明的欄位標題才不會跟輸入框隔一段空白。
      <div className="grid grid-cols-1 gap-x-5 gap-y-5 sm:grid-cols-2">
        {section.fields.map((field) => {
          const fullKey = `${section.keyPrefix}${field.key}`;
          // 1.44.0:showWhen 不成立的欄位不畫(值照舊保存,沒改就不會送出)。
          // 1.46.1:這段判斷寫在這裡,不呼叫別的模組的函式 —— 只要把讀自 state 的
          // 值交給 React Compiler 看不到內容的函式,它就當 state 之後可能被改動,
          // 於是整張設定頁的 useMemo 全部保不住(lint 的
          // react-hooks/preserve-manual-memoization 會擋,CI 直接紅)。
          const showWhen = field.showWhen;
          if (showWhen && state[`${section.keyPrefix}${showWhen.key}`] !== showWhen.equals) {
            return null;
          }
          const controlId = settingControlId(fullKey);
          // 分頁選項自己的說明(選到哪個就顯示哪個的)。
          const optionDescription =
            field.type === "select" && field.presentation === "tabs"
              ? field.options.find((o) => o.value === state[fullKey])?.description
              : undefined;
          const descriptionId =
            field.description || optionDescription ? `${controlId}-description` : undefined;
          return (
            <div
              key={fullKey}
              className={`row-span-3 grid min-w-0 grid-rows-subgrid items-start gap-y-1.5 ${fieldWrapperClass(field)}`}
            >
              <label id={`${controlId}-label`} htmlFor={controlId} className={labelClass()}>
                {resolveLocalizedString(field.label, locale)}
                {field.required && (
                  <span className="ml-1 text-red-600" aria-hidden="true">
                    *
                  </span>
                )}
              </label>
              {field.type === "textarea" ? (
                <Textarea
                  id={controlId}
                  aria-describedby={descriptionId}
                  aria-invalid={fieldErrors[fullKey] ? true : undefined}
                  className="min-h-[120px] rounded-[calc(10px*var(--admin-radius-scale,1))] border-ink/10 bg-surface text-[14px] text-ink/85 placeholder:text-ink/25"
                  value={String(state[fullKey] ?? "")}
                  aria-required={field.required || undefined}
                  onChange={(e) => update(fullKey, e.target.value)}
                />
              ) : field.type === "boolean" ? (
                <div className="inline-flex h-10 items-center rounded-[calc(10px*var(--admin-radius-scale,1))] bg-ink/[0.03] px-3 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]">
                  <Checkbox
                    id={controlId}
                    aria-describedby={descriptionId}
                    checked={Boolean(state[fullKey])}
                    aria-required={field.required || undefined}
                    onChange={(e) => update(fullKey, e.target.checked)}
                  />
                </div>
              ) : field.type === "color" ? (
                <ColorSwatchPicker
                  id={controlId}
                  label={resolveLocalizedString(field.label, locale) ?? field.key}
                  value={String(state[fullKey] ?? "")}
                  invalid={Boolean(fieldErrors[fullKey])}
                  onChange={(next) => update(fullKey, next)}
                  swatches={(field.swatches ?? []).map((swatch) => ({
                    value: swatch.value,
                    label: resolveLocalizedString(swatch.label, locale) ?? swatch.value,
                  }))}
                />
              ) : field.type === "select" && field.presentation === "tabs" ? (
                <SettingTabs
                  id={controlId}
                  labelledBy={`${controlId}-label`}
                  describedBy={descriptionId}
                  value={String(state[fullKey] ?? "")}
                  invalid={Boolean(fieldErrors[fullKey])}
                  onChange={(next) => update(fullKey, next)}
                  tabs={field.options.map((o) => ({
                    value: o.value,
                    label: resolveLocalizedString(o.label, locale) ?? o.value,
                    logo: o.logo,
                  }))}
                />
              ) : field.type === "select" ? (
                <Select
                  value={String(state[fullKey] ?? "")}
                  onValueChange={(next) => update(fullKey, String(next))}
                  // 沒給 items 時 Base UI 的 <Select.Value> 顯示的是原始值(「field」),
                  // 不是選項文字。
                  items={field.options.map((o) => ({
                    value: o.value,
                    label: resolveLocalizedString(o.label, locale),
                  }))}
                >
                  <SelectTrigger
                    id={controlId}
                    aria-describedby={descriptionId}
                    aria-invalid={fieldErrors[fullKey] ? true : undefined}
                    aria-required={field.required || undefined}
                    className="w-full rounded-[calc(10px*var(--admin-radius-scale,1))] border-ink/10 bg-surface text-[14px] text-ink/85"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    {field.options.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {resolveLocalizedString(o.label, locale)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : field.type === "number" && field.unit ? (
                // 1.52.0:有單位的數字(例如付款期限的分鐘數),右邊換算成好讀的說法。
                <div className="flex min-w-0 items-center gap-3">
                  <Input
                    id={controlId}
                    aria-describedby={[descriptionId, `${controlId}-unit`].filter(Boolean).join(" ")}
                    aria-invalid={fieldErrors[fullKey] ? true : undefined}
                    className="min-w-0 flex-1 rounded-[calc(10px*var(--admin-radius-scale,1))] border-ink/10 bg-surface text-[14px] text-ink/85 placeholder:text-ink/25"
                    type="number"
                    value={String(state[fullKey] ?? "")}
                    aria-required={field.required || undefined}
                    onChange={(e) => update(fullKey, e.target.value)}
                  />
                  <SettingUnitHint id={`${controlId}-unit`} unit={field.unit} value={state[fullKey]} />
                </div>
              ) : (
                <Input
                  id={controlId}
                  aria-describedby={descriptionId}
                  aria-invalid={fieldErrors[fullKey] ? true : undefined}
                  className="rounded-[calc(10px*var(--admin-radius-scale,1))] border-ink/10 bg-surface text-[14px] text-ink/85 placeholder:text-ink/25"
                  type={inputType(field)}
                  maxLength={field.type === "text" ? field.maxLength : undefined}
                  value={String(state[fullKey] ?? "")}
                  aria-required={field.required || undefined}
                  onChange={(e) => update(fullKey, e.target.value)}
                  // 伺服器把存過的密鑰遮成 "•••";沒存過的不該寫「已設定」。
                  placeholder={
                    field.secret && values[fullKey] === "•••" ? t("settings.secretSet") : undefined
                  }
                />
              )}
              <div className="flex min-w-0 flex-col gap-1.5">
                {fieldErrors[fullKey] && (
                  <p role="alert" className="text-[12px] text-red-600">
                    {fieldErrorText(fieldErrors[fullKey], t)}
                  </p>
                )}
                {(field.description || optionDescription) && (
                  <p id={descriptionId} className={descriptionClass()}>
                    {[field.description, optionDescription]
                      .filter(Boolean)
                      .map((text) => resolveLocalizedString(text, locale))
                      .join(" ")}
                  </p>
                )}
                {fullKey === "core.emailFrom" && (
                  <EmailDomainChips
                    value={String(state[fullKey] ?? "")}
                    onPick={(next) => update(fullKey, next)}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  function renderSection(section: SettingsSection) {
    return (
      <section
        key={section.id}
        id={sectionAnchorId(section.id)}
        className={cn("scroll-mt-20", SECTION_CARD)}
      >
        <div className="mb-5 flex flex-col gap-1">
          <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-ink/90">
            {section.title}
          </h3>
          {section.description && (
            <p className="text-[12px] text-ink/40">{section.description}</p>
          )}
        </div>
        {renderSectionFields(section)}
      </section>
    );
  }

  function renderSections(sectionsToRender: SettingsSection[]) {
    return (
      <>
        {sectionsToRender.map(renderSection)}
        {activeTab === "core" && renderExtraFieldsSection()}
        {activeTab === "core" && renderCoreAddonSection()}
      </>
    );
  }

  function renderDeclarativePlaceholder() {
    return (
      <section className={SECTION_CARD}>
        <div className="flex flex-col gap-1">
          <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-ink/90">
            {t("settingsWorkspace.declarative")}
          </h3>
          <p className="text-[12px] leading-relaxed text-ink/40">
            {t("settingsWorkspace.declarativeDesc")}
          </p>
        </div>
      </section>
    );
  }

  const router = useRouter();
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => resolveTab(initialTab, Boolean(styleTab)));
  const [state, setState] = useState<SettingsState>(() =>
    buildInitialState(sections, values),
  );
  const initialStateRef = useRef<SettingsState>(state);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showBar, setShowBar] = useState(false);
  // Show immediately (render-time "adjust state" — see UsersTable's
  // prevInitial pattern); only the delayed hide needs the effect, and that
  // setState happens async inside the timeout callback, not synchronously.
  const barActive = dirty || pending || saved;
  if (barActive && !showBar) setShowBar(true);

  useEffect(() => {
    if (barActive) return;
    const t = window.setTimeout(() => setShowBar(false), 220);
    return () => window.clearTimeout(t);
  }, [barActive]);

  const shownSections = useMemo(
    () => visibleSections(sections, activeTab),
    [sections, activeTab],
  );

  // 快速導覽:core/extensions 分頁內容常常一長串卡片往下疊,加一條 sticky 的
  // anchor-nav 讓人不用捲軸慢慢找。declarative 只有單一 placeholder 卡,不需要。
  const navTargets = useMemo(() => {
    const list = shownSections.map((s) => ({ id: s.id, label: s.title }));
    if (activeTab === "core" && extraFieldsNode) {
      list.push({ id: "extra-fields", label: t("extraFields.title") });
    }
    if (activeTab === "core" && coreAddonNode) {
      list.push({
        id: "core-addon",
        label: t("settingsWorkspace.registryAndTokens"),
      });
    }
    return list;
  }, [shownSections, activeTab, extraFieldsNode, coreAddonNode, t]);

  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  // activeSectionId 若不屬於這輪 navTargets(剛切分頁、章節增減)就退回第一個
  // 目標 —— 純 render-time 推導,不需要額外 state/effect 去同步它。
  const displayActiveId = navTargets.some((n) => n.id === activeSectionId)
    ? activeSectionId
    : (navTargets[0]?.id ?? null);

  // 用 id 查 DOM 而非 ref callback 收集 Map —— 在 callback ref 裡 mutate 一顆
  // useRef Map,會讓 React Compiler 判斷「memoization 無法保留」而放棄優化整個
  // 元件(連帶波及上面完全無關的 shownSections/navTargets useMemo)。section 本
  // 來就有穩定的 id 屬性,直接 getElementById 查沒有這個副作用。
  function scrollToSection(id: string) {
    document
      .getElementById(sectionAnchorId(id))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveSectionId(id);
  }

  useEffect(() => {
    if (navTargets.length <= 1) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;
        const top = visible.reduce((a, b) =>
          a.boundingClientRect.top < b.boundingClientRect.top ? a : b,
        );
        const id = top.target.id.replace(/^section-/, "");
        setActiveSectionId(id);
      },
      { rootMargin: "-88px 0px -70% 0px", threshold: 0 },
    );
    for (const { id } of navTargets) {
      const el = document.getElementById(sectionAnchorId(id));
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [navTargets]);

  function update(fullKey: string, value: string | boolean) {
    if (fieldErrors[fullKey]) {
      setFieldErrors((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([key]) => key !== fullKey)),
      );
    }
    setState((prev) => {
      const next = { ...prev, [fullKey]: value };
      setDirty(!sameState(next, initialStateRef.current));
      return next;
    });
    if (saved) setSaved(false);
  }

  function findField(fullKey: string) {
    const section = sections.find((s) =>
      s.fields.some((field) => `${s.keyPrefix}${field.key}` === fullKey),
    );
    const field = section?.fields.find((f) => `${section.keyPrefix}${f.key}` === fullKey);
    return section && field ? { section, field } : null;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);

    const entries = changedSettingEntries(sections, state, initialStateRef.current);

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      if (res.ok) {
        // 密鑰欄位存完就清空:明文不該留在畫面上,下次儲存也不會重送。
        const secretKeys = new Set(
          sections.flatMap((section) =>
            section.fields
              .filter((field) => field.secret)
              .map((field) => `${section.keyPrefix}${field.key}`),
          ),
        );
        const settled: SettingsState = Object.fromEntries(
          Object.entries(state).map(([key, value]) => [key, secretKeys.has(key) ? "" : value]),
        );
        setState(settled);
        initialStateRef.current = settled;
        setFieldErrors({});
        setDirty(false);
        setSaved(true);
        router.refresh();
        window.setTimeout(() => setSaved(false), 1200);
      } else if (res.status === 400) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          fields?: { key: string; code: string }[];
        } | null;
        if (body?.error === "invalid_values" && body.fields?.length) {
          setFieldErrors(
            Object.fromEntries(body.fields.map((f) => [f.key, f.code])),
          );
          const names = body.fields.map((f) => {
            const hit = findField(f.key);
            const label = hit
              ? `${hit.section.title} › ${resolveLocalizedString(hit.field.label, locale)}`
              : f.key;
            return `${label}(${fieldErrorText(f.code, t)})`;
          });
          setError(t("settingsWorkspace.fixFields", { fields: names.join("、") }));
        } else {
          setError(
            body?.error === "invalid_values"
              ? t("settingsWorkspace.invalidValues")
              : t("settingsWorkspace.invalidKey"),
          );
        }
      } else if (res.status === 403) {
        setError(t("settingsWorkspace.notAllowed"));
      } else {
        setError(t("settingsWorkspace.saveFailedError"));
      }
    } catch {
      setError(t("settingsWorkspace.networkError"));
    } finally {
      setPending(false);
    }
  }

  const bar = statusLine(pending, saved, error, t);

  // 分頁寫進網址(?tab=),重新整理或分享連結會停在同一頁;核心是預設,不帶參數。
  function selectTab(id: string) {
    const next = resolveTab(id, Boolean(styleTab));
    setActiveTab(next);
    const url = new URL(window.location.href);
    if (next === "core") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    url.hash = "";
    window.history.replaceState(null, "", url);
  }

  return (
    <div className="relative flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink/90">
            {t("settingsWorkspace.surface")}
          </h2>
          <p className="text-[12px] text-ink/40">
            {t("settingsWorkspace.surfaceSubtitle")}
          </p>
        </div>
        <FluidTabs
          compact
          tabs={[
            { id: "core", label: t("settingsWorkspace.core") },
            ...(styleTab ? [{ id: "style", label: t("settingsWorkspace.style") }] : []),
            { id: "declarative", label: t("settingsWorkspace.declarativeTab") },
            { id: "extensions", label: t("settingsWorkspace.extensions") },
          ]}
          defaultActive={activeTab}
          onChange={selectTab}
        />
      </div>

      {/* 切走時不卸載:沒存的風格草稿要留著。 */}
      {styleTab && <div hidden={activeTab !== "style"}>{styleTab}</div>}

      {activeTab !== "style" && (
        <form
          onSubmit={onSubmit}
          className={`flex flex-col gap-5 ${showBar ? "pb-28" : "pb-6"}`}
        >
          {navTargets.length > 1 && (
            <div className="sticky top-0 z-20 -mx-1 flex gap-1 overflow-x-auto rounded-t-[calc(14px*var(--admin-radius-scale,1))] bg-background/90 px-1 pt-1 shadow-[0_1px_0_rgba(0,0,0,0.06)] backdrop-blur-md">
              {navTargets.map((target) => (
                <NavAnchor
                  key={target.id}
                  label={target.label}
                  active={displayActiveId === target.id}
                  onClick={() => scrollToSection(target.id)}
                />
              ))}
            </div>
          )}

          {activeTab === "declarative"
            ? renderDeclarativePlaceholder()
            : renderSections(shownSections)}

          <SaveBar visible={showBar} title={bar.title} note={bar.note} alert={Boolean(error)}>
            <button type="submit" disabled={pending || !dirty} className={SAVE_BUTTON_CLASS}>
              <span>{pending ? t("settingsWorkspace.savingButton") : t("settingsWorkspace.saveAllChanges")}</span>
              {!pending && <span aria-hidden className="text-white/70">→</span>}
            </button>
          </SaveBar>
        </form>
      )}
    </div>
  );
}
