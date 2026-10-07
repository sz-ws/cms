"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import { EmailDomainChips } from "./EmailDomainChips";
import { ColorSwatchPicker } from "./ColorSwatchPicker";
import { SettingUnitHint } from "./SettingUnitHint";
import { SaveBar, SAVE_BUTTON_CLASS } from "./SaveBar";
import { SettingTabs } from "./SettingTabs";
import { useT, useLocale } from "@/lib/i18n/I18nProvider";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import {
  changedSettingEntries,
  keepEditsSinceSubmit,
  savedSettingsBaseline,
  settingControlId,
} from "@/lib/settings-ui";
import { SettingsNav } from "./SettingsNav";
import {
  AI_CONNECT_ID,
  CORE_ADDON_ID,
  DECLARATIVE_ID,
  EXTRA_FIELDS_ID,
  STYLE_ID,
  accountSettingsLink,
  buildSettingsNav,
  findSettingsField,
  flattenSettingsNav,
  resolveSettingsHash,
  resolveSettingsSelection,
  sectionAnchorId,
  sectionArea,
  settingsItemKey,
  settingsSectionStatus,
  settingsSelectionParams,
  type SettingsNavField,
  type SettingsNavItem,
} from "./settings-nav";
import {
  fieldReveal,
  firstInvalidControl,
  focusSettingControl,
  sectionTitleId,
  useLocationHash,
  type RevealRequest,
} from "./settings-reveal";

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
  /** 額外欄位管理(核心底下自己一區)。有自己的儲存鈕,不進這裡的表單。 */
  extraFieldsSection?: React.ReactNode;
  /**
   * 1.59.0:AI 連線(核心底下自己一區,排在 AI 設定後面)。開關與中斷連線
   * 各自即時生效,不進這裡的表單。
   */
  aiConnectSection?: React.ReactNode;
  /** 「風格」那一區的內容(AdminThemeEditor)。有自己的儲存鈕,不進這裡的表單。 */
  styleTab?: React.ReactNode;
  /** 網址的 ?tab=(核心 / 風格 / 宣告式 / 擴充功能),不認得的值回到核心。 */
  initialTab?: string;
  /** 網址的 ?section=:那個分類裡的哪一區;沒給就是第一區。 */
  initialSection?: string;
  /** 網站已啟用的登入方式的名字:搜尋時打這些字也找得到帳戶頁的連結。 */
  accountKeywords?: readonly string[];
}

type SettingsState = Record<string, string | boolean>;

const STYLE_KEY = settingsItemKey("style", STYLE_ID);
const DECLARATIVE_KEY = settingsItemKey("declarative", DECLARATIVE_ID);
const AI_CONNECT_KEY = settingsItemKey("core", AI_CONNECT_ID);
const EXTRA_FIELDS_KEY = settingsItemKey("core", EXTRA_FIELDS_ID);
const CORE_ADDON_KEY = settingsItemKey("core", CORE_ADDON_ID);

// 每一組設定是一張單層卡片(同角色頁與成員表格)。外面再包一圈玻璃框,
// 「細邊線」風格下兩層陰影都變成 1px 線,會畫成兩道邊。
const SECTION_CARD =
  "rounded-[calc(14px*var(--admin-radius-scale,1))] bg-surface px-6 pt-6 pb-5 shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04))]";

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
  // 其餘欄位在卡片夠寬(@lg)時佔半欄。
  return field.type === "textarea" || isTabs(field)
    ? "col-span-full"
    : "col-span-full @lg:col-span-1";
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
  aiConnectSection,
  styleTab,
  initialTab,
  initialSection,
  accountKeywords,
}: SettingsWorkspaceProps) {
  const t = useT();
  // §1 #9–#11:extension settings 的 label/description/option.label 可為 LocalizedString;
  // admin 有 I18nProvider,故直接 useLocale() resolve(核心 settings 為純字串,原樣透傳)。
  const locale = useLocale();
  const coreAddonNode = coreAddon ?? null;
  const extraFieldsNode = extraFieldsSection ?? null;
  const aiConnectNode = aiConnectSection ?? null;
  // fullKey → 伺服器回的錯誤碼;改動該欄位就清掉那一格的錯誤。
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // 有自己儲存鈕的區塊(AI 連線、額外欄位、來源與權杖):沒選到時收起來但不卸載,
  // 裡面打到一半的東西才不會因為換區就不見(同下面的風格)。
  function renderPanel(key: string, id: string, node: React.ReactNode) {
    if (!node) return null;
    return (
      <section id={sectionAnchorId(id)} hidden={selected?.key !== key} className={SECTION_CARD}>
        {node}
      </section>
    );
  }

  function renderSectionFields(section: SettingsSection) {
    return (
      // 每個欄位佔三列(標題 / 輸入框 / 說明),用 subgrid 跟同一排的欄位共用列高:
      // 一邊有說明、一邊沒有,或標題折成兩行時,兩邊的輸入框仍然對齊。
      // 說明放在輸入框下面,沒有說明的欄位標題才不會跟輸入框隔一段空白。
      // 夠寬才兩欄並排,看的是卡片的寬度(@lg,卡片是 @container)不是視窗:左邊多了
      // 一欄清單,同一個視窗寬度下卡片比以前窄。
      <div className="grid grid-cols-1 gap-x-5 gap-y-5 @lg:grid-cols-2">
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
          // 1.67.0:enabledWhen 不成立的欄位照樣畫,但反灰、不能改(值照舊保存)。
          // 判斷寫在這裡的理由同上面的 showWhen。
          const enabledWhen = field.enabledWhen;
          const controller = enabledWhen ? state[`${section.keyPrefix}${enabledWhen.key}`] : undefined;
          const off = enabledWhen
            ? !enabledWhen.oneOf.some((allowed) => allowed === controller)
            : false;
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
              className={cn(
                "row-span-3 grid min-w-0 grid-rows-subgrid items-start gap-y-1.5 transition-opacity duration-150",
                fieldWrapperClass(field),
                off && "opacity-55",
              )}
              // 色票與分頁沒有自己的 disabled,整格設成 inert;其餘控制項各自 disabled(讀屏會唸「停用」)。
              inert={off && (field.type === "color" || (field.type === "select" && field.presentation === "tabs"))}
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
                  className="min-h-[120px] rounded-[calc(10px*var(--admin-radius-scale,1))] border-ink/10 bg-surface text-[14px] text-ink/85 disabled:bg-ink/[0.06] disabled:opacity-100 placeholder:text-ink/25"
                  maxLength={field.maxLength}
                  value={String(state[fullKey] ?? "")}
                  aria-required={field.required || undefined}
                  disabled={off}
                  onChange={(e) => update(fullKey, e.target.value)}
                />
              ) : field.type === "boolean" ? (
                <div className="inline-flex h-10 items-center rounded-[calc(10px*var(--admin-radius-scale,1))] bg-ink/[0.03] px-3 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]">
                  <Checkbox
                    id={controlId}
                    aria-describedby={descriptionId}
                    checked={Boolean(state[fullKey])}
                    aria-required={field.required || undefined}
                    disabled={off}
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
                  disabled={off}
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
                    className="w-full rounded-[calc(10px*var(--admin-radius-scale,1))] border-ink/10 bg-surface text-[14px] text-ink/85 disabled:bg-ink/[0.06] disabled:opacity-100"
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
                    className="min-w-0 flex-1 rounded-[calc(10px*var(--admin-radius-scale,1))] border-ink/10 bg-surface text-[14px] text-ink/85 disabled:bg-ink/[0.06] disabled:opacity-100 placeholder:text-ink/25"
                    type="number"
                    value={String(state[fullKey] ?? "")}
                    aria-required={field.required || undefined}
                    disabled={off}
                    onChange={(e) => update(fullKey, e.target.value)}
                  />
                  <SettingUnitHint id={`${controlId}-unit`} unit={field.unit} value={state[fullKey]} />
                </div>
              ) : (
                <Input
                  id={controlId}
                  aria-describedby={descriptionId}
                  aria-invalid={fieldErrors[fullKey] ? true : undefined}
                  className="rounded-[calc(10px*var(--admin-radius-scale,1))] border-ink/10 bg-surface text-[14px] text-ink/85 disabled:bg-ink/[0.06] disabled:opacity-100 placeholder:text-ink/25"
                  type={inputType(field)}
                  maxLength={field.type === "text" ? field.maxLength : undefined}
                  value={String(state[fullKey] ?? "")}
                  aria-required={field.required || undefined}
                  disabled={off}
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

  function renderSection(section: SettingsSection, key: string) {
    return (
      // key:換區時整張卡重來,上一區的輸入框不會被 React 拿去接著用。
      // data-settings-fields:送出前只檢查這張卡裡的輸入框(見 firstInvalidControl)。
      <section
        key={key}
        id={sectionAnchorId(section.id)}
        data-settings-fields=""
        className={cn("@container", SECTION_CARD)}
      >
        <div className="mb-5 flex flex-col gap-1">
          <h3
            id={sectionTitleId(section.id)}
            tabIndex={-1}
            className="text-[17px] font-semibold tracking-[-0.01em] text-ink/90 outline-none"
          >
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

  function renderDeclarativePlaceholder() {
    return (
      <section id={sectionAnchorId(DECLARATIVE_ID)} className={SECTION_CARD}>
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
  const hasStyle = Boolean(styleTab);
  const hasAiConnect = Boolean(aiConnectNode);
  const hasExtraFields = Boolean(extraFieldsNode);
  const hasCoreAddon = Boolean(coreAddonNode);

  // 左邊清單的內容:四個分類就是原本的四個分頁,每一區一列。
  const navGroups = useMemo(
    () =>
      buildSettingsNav({
        sections,
        locale,
        areaLabels: {
          core: t("settingsWorkspace.core"),
          style: t("settingsWorkspace.style"),
          declarative: t("settingsWorkspace.declarativeTab"),
          extensions: t("settingsWorkspace.extensions"),
        },
        panels: {
          aiConnect: hasAiConnect
            ? { title: t("aiConnect.title"), description: t("aiConnect.desc") }
            : undefined,
          extraFields: hasExtraFields
            ? { title: t("extraFields.title"), description: t("extraFields.desc") }
            : undefined,
          // 這一區裡是擴充功能來源、API 權杖與匯出內容三塊,搜尋時三個名字都找得到。
          coreAddon: hasCoreAddon
            ? {
                title: t("settingsWorkspace.registryAndTokens"),
                keywords: [t("registry.title"), t("apiTokens.title"), t("export.title")].join(" "),
              }
            : undefined,
          style: hasStyle
            ? { title: t("settingsWorkspace.style"), keywords: t("settingsNav.styleKeywords") }
            : undefined,
          declarative: { title: t("settingsWorkspace.declarative") },
        },
      }),
    [sections, locale, t, hasAiConnect, hasExtraFields, hasCoreAddon, hasStyle],
  );
  const navLinks = [
    accountSettingsLink(
      {
        title: t("settingsNav.account"),
        description: t("settingsNav.accountDesc"),
        keywords: t("settingsNav.accountKeywords"),
      },
      accountKeywords,
    ),
  ];

  // 選到哪一區。網址(?tab= / ?section=)只決定一開始在哪;之後換區是這裡的 state,
  // 網址跟著改(selectItem),不重新載入頁面。
  const [selectedKey, setSelectedKey] = useState<string | null>(
    () => resolveSettingsSelection(navGroups, { tab: initialTab, section: initialSection })?.key ?? null,
  );
  // 人已經在設定頁時又點了一個設定頁的連結(側欄的「設定」、別的元件的 ?tab= 連結):網址換了、
  // 這個元件沒有重新掛載,所以跟著網址上的 ?tab= / ?section= 換區 —— render 中跟著輸入重設 state,
  // 不用 key 重掛(那樣沒存的修改會不見)。看的是網址本身(useSearchParams),不是 initialTab:
  // 這一頁自己換區只改網址(selectItem 的 replaceState),伺服器給的 initialTab 不會跟著變。
  const searchParams = useSearchParams();
  const urlTab = searchParams.get("tab") ?? undefined;
  const urlSection = searchParams.get("section") ?? undefined;
  const urlSelection = `${urlTab ?? ""}/${urlSection ?? ""}`;
  const [appliedUrlSelection, setAppliedUrlSelection] = useState(urlSelection);
  if (urlSelection !== appliedUrlSelection) {
    setAppliedUrlSelection(urlSelection);
    setSelectedKey(resolveSettingsSelection(navGroups, { tab: urlTab, section: urlSection })?.key ?? null);
  }
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // 別頁既有的連結用 #section-<id> 指到某一區。# 變了就換到那一區 —— render 中跟著
  // 輸入重設 state(同下面的 showBar),不用 effect。
  const hash = useLocationHash();
  const [appliedHash, setAppliedHash] = useState("");
  if (hash !== appliedHash) {
    setAppliedHash(hash);
    const target = resolveSettingsHash(navGroups, hash, initialTab);
    if (target) {
      setSelectedKey(target.item.key);
      setReveal(target.field ? fieldReveal(target.item, target.field) : { kind: "section" });
    }
  }

  // 清單變了(擴充功能停用、章節增減)而選到的那一區不在了:退回第一區。
  const navItems = flattenSettingsNav(navGroups);
  const selected = navItems.find((item) => item.key === selectedKey) ?? navItems[0] ?? null;
  const selectedArea = selected ? navGroups.find((group) => group.area === selected.area) : undefined;
  const styleShown = selected?.key === STYLE_KEY;
  const shownSection =
    selected?.kind === "fields"
      ? sections.find((section) => settingsItemKey(sectionArea(section), section.id) === selected.key)
      : undefined;

  const [state, setState] = useState<SettingsState>(() =>
    buildInitialState(sections, values),
  );
  // 上次儲存後的值。畫面上一次只有一區,但 state 與這份對照值都是整頁的:
  // 沒顯示的區改過的值留在 state 裡,照樣算「有變更」、照樣一起送出。
  const [baseline, setBaseline] = useState<SettingsState>(state);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const dirty = !sameState(state, baseline);
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

  // 清單上的標記:哪幾區有還沒存的變更、必填還沒填、儲存時被退回。
  const status = settingsSectionStatus({ sections, state, baseline, saved: values, fieldErrors });

  // 換區之後:指定了欄位就把焦點放上去;否則如果原本捲到下面,把新的一區帶回畫面裡。
  useEffect(() => {
    if (!reveal) return;
    if (reveal.kind === "field") {
      focusSettingControl(reveal.controlId, reveal.fallbackId);
      return;
    }
    const content = contentRef.current;
    if (content && content.getBoundingClientRect().top < 0) {
      content.scrollIntoView({ block: "start" });
    }
  }, [reveal]);

  // 換到某一區(可以指定要停在哪個欄位),網址跟著改:重新整理或把連結給別人會停在
  // 同一區。核心是預設不帶 tab,每個分類的第一區不帶 section(舊連結的樣子不變)。
  function selectItem(item: SettingsNavItem, field?: SettingsNavField) {
    // 這一區有瀏覽器認為填錯的欄位(數字框打到一半、日期只填一半)時先留在這裡指出來:
    // 那種欄位在 state 裡是空的,換區之後它不在畫面上,按儲存會把原本的值清掉。
    const form = contentRef.current?.closest("form");
    const invalid = item.key !== selected?.key && form ? firstInvalidControl(form) : null;
    if (invalid) {
      invalid.reportValidity();
      return;
    }
    setSelectedKey(item.key);
    setReveal(field ? fieldReveal(item, field) : { kind: "section" });
    const url = new URL(window.location.href);
    const { tab, section } = settingsSelectionParams(navGroups, item);
    if (tab) url.searchParams.set("tab", tab);
    else url.searchParams.delete("tab");
    if (section) url.searchParams.set("section", section);
    else url.searchParams.delete("section");
    url.hash = "";
    window.history.replaceState(null, "", url);
  }

  function update(fullKey: string, value: string | boolean) {
    if (fieldErrors[fullKey]) {
      setFieldErrors((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([key]) => key !== fullKey)),
      );
    }
    setState((prev) => ({ ...prev, [fullKey]: value }));
    if (saved) setSaved(false);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // 表單是 noValidate:瀏覽器自己擋的話,只要有一個看不到的欄位不合格(收起來的區塊裡的),
    // 整頁就默默送不出去。所以改成自己檢查畫面上這一區,不合格的照瀏覽器原本的方式指出來。
    // 沒顯示的區沒有輸入框,它們的值由伺服器檢查,被退回時下面會換到那一區。
    const invalid = firstInvalidControl(e.currentTarget);
    if (invalid) {
      invalid.reportValidity();
      return;
    }
    setError(null);
    setSaved(false);
    setPending(true);

    // 送出當下的值。等回應時欄位還能改(也可能已經換到別區),存好之後要分得出哪些是後來改的。
    const submitted = state;
    const entries = changedSettingEntries(sections, submitted, baseline);

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      if (res.ok) {
        // 密鑰欄位存完就清空:明文不該留在畫面上,下次儲存也不會重送。
        // 等回應時又改的欄位留著,照樣算還沒存(以前會被這裡蓋回送出時的值)。
        const settled = savedSettingsBaseline(sections, submitted);
        setState((current) => keepEditsSinceSubmit(current, submitted, settled));
        setBaseline(settled);
        setFieldErrors({});
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
            const hit = findSettingsField(navGroups, f.key);
            const label = hit ? `${hit.item.title} › ${hit.field.label}` : f.key;
            return `${label}(${fieldErrorText(f.code, t)})`;
          });
          setError(t("settingsWorkspace.fixFields", { fields: names.join("、") }));
          // 被退回的欄位可能在沒顯示的區:換到那一區,把焦點放到欄位上(欄位下面有原因)。
          // 目前這一區就有的話留在原地。
          const rejected = body.fields.flatMap((f) => {
            const hit = findSettingsField(navGroups, f.key);
            return hit ? [hit] : [];
          });
          const target = rejected.find((hit) => hit.item.key === selected?.key) ?? rejected[0];
          if (target) selectItem(target.item, target.field);
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

  return (
    <div className="grid min-w-0 grid-cols-1 gap-x-7 gap-y-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <SettingsNav
        groups={navGroups}
        links={navLinks}
        selected={selected}
        status={status}
        saveBarVisible={showBar && !styleShown}
        onSelect={selectItem}
      />

      <div ref={contentRef} className="min-w-0 scroll-mt-6">
        {selectedArea && <h2 className="sr-only">{selectedArea.label}</h2>}

        {/* 切走時不卸載:沒存的風格草稿要留著。 */}
        {styleTab && (
          <div id={sectionAnchorId(STYLE_ID)} hidden={!styleShown}>
            {styleTab}
          </div>
        )}

        {/* 一個表單、一顆儲存鈕管全部的區:畫面上只有選到的那一區,其餘的值在 state 裡。 */}
        <form
          noValidate
          hidden={styleShown}
          onSubmit={onSubmit}
          className={`flex flex-col gap-5 ${showBar ? "pb-28" : "pb-6"}`}
        >
          {shownSection && selected && renderSection(shownSection, selected.key)}
          {renderPanel(AI_CONNECT_KEY, AI_CONNECT_ID, aiConnectNode)}
          {renderPanel(EXTRA_FIELDS_KEY, EXTRA_FIELDS_ID, extraFieldsNode)}
          {renderPanel(CORE_ADDON_KEY, CORE_ADDON_ID, coreAddonNode)}
          {selected?.key === DECLARATIVE_KEY && renderDeclarativePlaceholder()}

          <SaveBar visible={showBar} title={bar.title} note={bar.note} alert={Boolean(error)}>
            <button type="submit" disabled={pending || !dirty} className={SAVE_BUTTON_CLASS}>
              <span>{pending ? t("settingsWorkspace.savingButton") : t("settingsWorkspace.saveAllChanges")}</span>
              {!pending && <span aria-hidden className="text-white/70">→</span>}
            </button>
          </SaveBar>
        </form>
      </div>
    </div>
  );
}
