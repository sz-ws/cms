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
import { useT } from "@/lib/i18n/I18nProvider";

export interface SettingsSection {
  id: string;
  title: string;
  description: string;
  keyPrefix: string;
  fields: SettingField[];
}

interface SettingsWorkspaceProps {
  sections: SettingsSection[];
  values: Record<string, unknown>;
  coreAddon?: React.ReactNode;
}

type SettingsState = Record<string, string | boolean>;
type SettingsTab = "core" | "declarative" | "extensions";

function initialValue(
  field: SettingField,
  values: Record<string, unknown>,
  keyPrefix: string,
): string | boolean {
  if (field.secret) return "";
  const fullKey = `${keyPrefix}${field.key}`;
  const v = values[fullKey];
  if (field.type === "boolean") return Boolean(v);
  const raw = v === undefined || v === null ? (field.default ?? "") : v;
  if (field.type === "textarea" && typeof raw !== "string") {
    return JSON.stringify(raw);
  }
  return String(raw);
}

function parseTextareaValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
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

function fieldWrapperClass(field: SettingField): string {
  return field.type === "textarea"
    ? "col-span-full"
    : "col-span-full sm:col-span-1";
}

function labelClass(): string {
  return "text-[13px] font-medium text-black/55";
}

function descriptionClass(): string {
  return "text-[12px] leading-relaxed text-black/40";
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
        active ? "text-black/90" : "text-black/40 hover:text-black/65",
      )}
    >
      {label}
      <span
        aria-hidden
        className={cn(
          "absolute inset-x-3 -bottom-px h-[2px] rounded-full transition-opacity duration-150",
          active ? "opacity-100" : "opacity-0",
        )}
        style={{ backgroundColor: "var(--accent-blue)" }}
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

export function SettingsWorkspace({ sections, values, coreAddon }: SettingsWorkspaceProps) {
  const t = useT();
  const coreAddonNode = coreAddon ?? null;

  // Registry manager + API tokens:core tab 最後一張獨立卡(不塞進任何分組卡)。
  function renderCoreAddonSection() {
    if (!coreAddonNode) return null;
    return (
      <section
        key="core-addon"
        id={sectionAnchorId("core-addon")}
        className="scroll-mt-20 rounded-[20px] bg-white/55 p-1.5 shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_16px_48px_-12px_rgba(30,20,50,0.18)] backdrop-blur-md"
      >
        <div className="rounded-[14px] bg-white px-6 pt-6 pb-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]">
          {coreAddonNode}
        </div>
      </section>
    );
  }

  function renderSectionFields(section: SettingsSection) {
    return (
      <div className="grid grid-cols-1 gap-x-5 gap-y-5 sm:grid-cols-2">
        {section.fields.map((field) => {
          const fullKey = `${section.keyPrefix}${field.key}`;
          return (
            <div
              key={fullKey}
              className={`flex min-w-0 flex-col gap-1.5 ${fieldWrapperClass(field)}`}
            >
              <label className={labelClass()}>{field.label}</label>
              {field.description && (
                <p className={descriptionClass()}>{field.description}</p>
              )}
              {field.type === "textarea" ? (
                <Textarea
                  className="min-h-[120px] rounded-[10px] border-black/10 bg-white text-[14px] text-black/85 placeholder:text-black/25"
                  value={String(state[fullKey] ?? "")}
                  onChange={(e) => update(fullKey, e.target.value)}
                />
              ) : field.type === "boolean" ? (
                <div className="inline-flex h-10 items-center rounded-[10px] bg-black/[0.03] px-3 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]">
                  <Checkbox
                    checked={Boolean(state[fullKey])}
                    onChange={(e) => update(fullKey, e.target.checked)}
                  />
                </div>
              ) : field.type === "select" ? (
                <Select
                  value={String(state[fullKey] ?? "")}
                  onValueChange={(next) => update(fullKey, String(next))}
                >
                  <SelectTrigger className="w-full rounded-[10px] border-black/10 bg-white text-[14px] text-black/85">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    {field.options.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  className="rounded-[10px] border-black/10 bg-white text-[14px] text-black/85 placeholder:text-black/25"
                  type={field.type === "number" ? "number" : "text"}
                  value={String(state[fullKey] ?? "")}
                  onChange={(e) => update(fullKey, e.target.value)}
                  placeholder={field.secret ? "已設定,輸入以覆寫" : undefined}
                />
              )}
              {fullKey === "core.emailFrom" && (
                <EmailDomainChips
                  value={String(state[fullKey] ?? "")}
                  onPick={(next) => update(fullKey, next)}
                />
              )}
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
        className="scroll-mt-20 rounded-[20px] bg-white/55 p-1.5 shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_16px_48px_-12px_rgba(30,20,50,0.18)] backdrop-blur-md"
      >
        <div className="rounded-[14px] bg-white px-6 pt-6 pb-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]">
          <div className="mb-5 flex flex-col gap-1">
            <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-black/90">
              {section.title}
            </h3>
            <p className="text-[12px] text-black/40">{section.description}</p>
          </div>
          {renderSectionFields(section)}
        </div>
      </section>
    );
  }

  function renderSections(sectionsToRender: SettingsSection[]) {
    return (
      <>
        {sectionsToRender.map(renderSection)}
        {activeTab === "core" && renderCoreAddonSection()}
      </>
    );
  }

  function renderDeclarativePlaceholder() {
    return (
      <section className="rounded-[20px] bg-white/55 p-1.5 shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_16px_48px_-12px_rgba(30,20,50,0.18)] backdrop-blur-md">
        <div className="rounded-[14px] bg-white px-6 pt-6 pb-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]">
          <div className="flex flex-col gap-1">
            <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-black/90">
              {t("settingsWorkspace.declarative")}
            </h3>
            <p className="text-[12px] leading-relaxed text-black/40">
              {t("settingsWorkspace.declarativeDesc")}
            </p>
          </div>
        </div>
      </section>
    );
  }

  const router = useRouter();
  const [activeTab, setActiveTab] = useState<SettingsTab>("core");
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
    if (activeTab === "core" && coreAddonNode) {
      list.push({
        id: "core-addon",
        label: t("settingsWorkspace.registryAndTokens"),
      });
    }
    return list;
  }, [shownSections, activeTab, coreAddonNode, t]);

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
    setState((prev) => {
      const next = { ...prev, [fullKey]: value };
      setDirty(!sameState(next, initialStateRef.current));
      return next;
    });
    if (saved) setSaved(false);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);

    const entries: Record<string, unknown> = {};
    for (const section of sections) {
      for (const field of section.fields) {
        const fullKey = `${section.keyPrefix}${field.key}`;
        const val = state[fullKey];
        if (field.secret && (val === "" || val === "•••")) continue;
        if (field.type === "number") {
          entries[fullKey] = Number(val);
        } else if (field.type === "textarea" && typeof val === "string") {
          entries[fullKey] = parseTextareaValue(val);
        } else {
          entries[fullKey] = val;
        }
      }
    }

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      if (res.ok) {
        initialStateRef.current = state;
        setDirty(false);
        setSaved(true);
        router.refresh();
        window.setTimeout(() => setSaved(false), 1200);
      } else if (res.status === 400) {
        setError(t("settingsWorkspace.invalidKey"));
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
    <form
      onSubmit={onSubmit}
      className={`relative flex flex-col gap-5 ${showBar ? "pb-28" : "pb-6"}`}
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-black/90">
            {t("settingsWorkspace.surface")}
          </h2>
          <p className="text-[12px] text-black/40">
            {t("settingsWorkspace.surfaceSubtitle")}
          </p>
        </div>
        <FluidTabs
          compact
          tabs={[
            { id: "core", label: t("settingsWorkspace.core") },
            { id: "declarative", label: t("settingsWorkspace.declarativeTab") },
            { id: "extensions", label: t("settingsWorkspace.extensions") },
          ]}
          defaultActive="core"
          onChange={(id) => {
            const next = ["core", "declarative", "extensions"].includes(id)
              ? (id as SettingsTab)
              : "core";
            setActiveTab(next);
          }}
        />
      </div>

      {navTargets.length > 1 && (
        <div className="sticky top-0 z-20 -mx-1 flex gap-1 overflow-x-auto rounded-t-[14px] bg-[#fbfaf9]/90 px-1 pt-1 shadow-[0_1px_0_rgba(0,0,0,0.06)] backdrop-blur-md">
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

      <div
        className={[
          "pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4 transition-[opacity,transform] duration-220 ease-out",
          showBar ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0",
        ].join(" ")}
      >
        <div className="pointer-events-auto w-full max-w-4xl rounded-[20px] bg-white/65 p-1.5 shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_16px_48px_-12px_rgba(30,20,50,0.18)] backdrop-blur-md">
          <div className="flex items-center justify-between gap-4 rounded-[14px] bg-white px-4 py-3 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[12px] font-medium text-black/45">
                {bar.title}
              </span>
              <span className="text-[11px] text-black/35">{bar.note}</span>
            </div>
            <button
              type="submit"
              disabled={pending || !dirty}
              className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[8px] bg-black pr-3 pl-3.5 text-[14px] font-medium text-white transition-[background-color,transform] duration-150 ease-out hover:bg-black/85 active:scale-[0.96] focus-visible:shadow-[0_0_0_3px_rgba(0,0,0,0.15)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45"
            >
              <span>{pending ? t("settingsWorkspace.savingButton") : t("settingsWorkspace.saveAllChanges")}</span>
              {!pending && <span aria-hidden className="text-white/70">→</span>}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
