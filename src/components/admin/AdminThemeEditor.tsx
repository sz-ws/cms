"use client";

import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { Check } from "lucide-react";
import { useLocale } from "@/lib/i18n/I18nProvider";
import {
  ADMIN_FONTS, ADMIN_ICON_SETS, ADMIN_THEME_PRESETS, adminFont, adminFontHref, adminThemeSchema, adminThemeVariables,
  cacheAdminAppearance, isDefaultAdminTheme, type AdminAppearance,
} from "@/lib/admin-theme";
import { ADMIN_ACCENT_SWATCHES } from "@/lib/admin-accent";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import { ColorSwatchPicker, type ColorSwatch } from "./ColorSwatchPicker";
import { SettingTabs } from "./SettingTabs";
import { AdminThemePreview } from "./AdminThemePreview";
import { SaveBar, SAVE_BAR_SECONDARY_CLASS, SAVE_BUTTON_CLASS } from "./SaveBar";
import { cn } from "@/lib/utils";

const copy = {
  en: {
    title: "Style", subtitle: "A shared look for your admin workspace. Your public website stays as designed.",
    presets: "Start with a style", colors: "Color", font: "Typeface", shape: "Shape", icons: "Sidebar icons", solid: "Solid", outline: "Outline",
    accent: "Accent", background: "Background", surface: "Surface", ink: "Text",
    radius: "Corners", sharp: "Sharp", soft: "Soft", round: "Round", elevation: "Depth", flat: "Flat", line: "Hairline",
    preview: "Live preview", previewNote: "Only this preview changes until you save.",
    save: "Save style", saving: "Saving…", discard: "Discard changes",
    dirty: "Unsaved style changes", dirtyNote: "Saving applies it for every admin.",
    saved: "Style saved", savedNote: "Every admin now sees this style.",
    failedTitle: "Could not save", failed: "Your changes are still here. Please try again.",
    forbidden: "Your session cannot save settings. Sign in as an administrator.",
    unreadable: (where: string) => `Text is hard to read on the ${where.toLowerCase()}. Choose a lighter color there, or darker text.`, and: " and ",
  },
  "zh-Hant": {
    title: "風格", subtitle: "為所有管理員設定一致的後台外觀。公開網站維持原本設計。",
    presets: "從一款風格開始", colors: "配色", font: "字體", shape: "形狀", icons: "側欄圖示", solid: "實心", outline: "線條",
    accent: "主色", background: "背景", surface: "卡片與面板", ink: "文字",
    radius: "圓角", sharp: "俐落", soft: "柔和", round: "圓潤", elevation: "層次", flat: "平面", line: "細邊線",
    preview: "即時預覽", previewNote: "儲存前只有這裡會變。",
    save: "儲存風格", saving: "儲存中…", discard: "放棄變更",
    dirty: "風格有尚未儲存的變更", dirtyNote: "儲存後，所有管理員的後台都會套用。",
    saved: "已儲存", savedNote: "所有管理員的後台已經套用。",
    failedTitle: "儲存失敗", failed: "調整仍保留在這裡，請再試一次。",
    forbidden: "目前登入狀態無法儲存，請以管理員帳號重新登入。",
    unreadable: (where: string) => `文字在${where}上不夠清楚，請改用淺一點的底色，或深一點的文字。`, and: "、",
  },
};

const equal = (a: AdminAppearance, b: AdminAppearance) => JSON.stringify(a) === JSON.stringify(b);
const isHex = (value: string) => /^#[0-9a-f]{6}$/.test(value);
const COLOR_KEYS = ["accent", "background", "surface", "ink"] as const;
const SHAPE_OPTIONS = { radius: ["sharp", "soft", "round"], elevation: ["flat", "line", "soft"] } as const;
const readable = (next: AdminAppearance) => adminThemeSchema.safeParse(next.theme).success && isHex(next.accent);
const FONT_HREFS = ADMIN_FONTS.map((font) => adminFontHref(font.id)).filter((href): href is string => href !== null);

/** 字體選項用自己的字體寫名字:打開編輯器才載入 Google Fonts 的 CSS(不擋首次繪製),
 * 字檔只在文字真的畫出來時才下載。AdminTheme 已經載入的同一支會被略過。 */
function useFontStylesheets() {
  useEffect(() => {
    for (const href of FONT_HREFS) {
      if (document.querySelector(`link[rel="stylesheet"][href="${CSS.escape(href)}"]`)) continue;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      document.head.appendChild(link);
    }
  }, []);
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-ink/[0.06] pt-5 first:border-t-0 first:pt-0">
      <h4 className="mb-3.5 text-[13px] font-medium text-ink/85">{title}</h4>
      {children}
    </section>
  );
}

export function AdminThemeEditor({ initial }: { initial: AdminAppearance }) {
  const locale = useLocale();
  const c = copy[locale];
  const [saved, setSaved] = useState(initial);
  const [previous, setPrevious] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [preview, setPreview] = useState(initial);
  const [pending, setPending] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const dirty = !equal(draft, saved);
  const check = adminThemeSchema.safeParse(draft.theme);
  const valid = check.success && isHex(draft.accent);
  // 選色器只會給合法 #rrggbb,會擋下來的只剩對比:背景或卡片太暗、文字太淺。
  const unreadable = check.success ? [] : (["background", "surface"] as const).filter((key) => check.error.issues.some((issue) => issue.path[0] === key));
  useFontStylesheets();
  // Refresh may bring another admin's changes; preserve an in-progress draft.
  if (!equal(previous, initial)) {
    setPrevious(initial);
    setSaved(initial);
    if (!dirty) { setDraft(initial); setPreview(initial); }
  }
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    if (!justSaved) return;
    const timer = window.setTimeout(() => setJustSaved(false), 1600);
    return () => window.clearTimeout(timer);
  }, [justSaved]);

  function change(next: AdminAppearance) {
    setDraft(next);
    setJustSaved(false);
    setFailure(null);
    if (readable(next)) setPreview(next);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || !dirty || pending) return;
    setPending(true); setFailure(null);
    try {
      const response = await fetch("/api/admin-theme", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? c.forbidden : c.failed);
      const next: AdminAppearance = await response.json();
      setSaved(next); setDraft(next); setPreview(next);
      // 不 router.refresh():AdminTheme 收 cacheAdminAppearance 的事件就換上新風格。
      // 重拿頁面在 dev 會把整支 CSS 換成新的 ?v= 版本,換的那一瞬間整頁沒有樣式。
      cacheAdminAppearance(next);
      setJustSaved(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : c.failed);
    } finally { setPending(false); }
  }

  const swatches: Record<(typeof COLOR_KEYS)[number], ColorSwatch[]> = {
    accent: ADMIN_ACCENT_SWATCHES.map((swatch) => ({ value: swatch.value, label: resolveLocalizedString(swatch.label, locale) ?? swatch.value })),
    background: ADMIN_THEME_PRESETS.map((item) => ({ value: item.appearance.theme.background, label: item.name[locale] })),
    surface: ADMIN_THEME_PRESETS.map((item) => ({ value: item.appearance.theme.surface, label: item.name[locale] })),
    ink: ADMIN_THEME_PRESETS.map((item) => ({ value: item.appearance.theme.ink, label: item.name[locale] })),
  };
  const previewStyle = { ...adminThemeVariables(preview), fontFamily: adminFont(preview.theme.font).family } as CSSProperties;
  // 紙與墨預覽要回到原本的 token,即使外層已存了別的風格(admin-theme.css)。
  const previewMode = isDefaultAdminTheme(preview.theme) ? "default" : "custom";
  const preset = ADMIN_THEME_PRESETS.find((item) => equal(item.appearance, draft));
  const bar = pending
    ? { title: c.saving, note: c.dirtyNote }
    : failure ? { title: c.failedTitle, note: failure }
    : justSaved ? { title: c.saved, note: c.savedNote }
    : { title: c.dirty, note: c.dirtyNote };
  const setTheme = (patch: Partial<AdminAppearance["theme"]>) => change({ ...draft, theme: { ...draft.theme, ...patch } });
  const barVisible = dirty || pending || justSaved || failure !== null;

  return (
    // 外框與標題比照設定頁其他分組卡(SettingsWorkspace 的 renderSection)。
    <form onSubmit={submit} aria-labelledby="admin-style-title" className={cn(barVisible && "mb-24", "rounded-[calc(20px*var(--admin-radius-scale,1))] bg-surface/55 p-1.5 shadow-[var(--admin-shadow-panel,0_0_0_1px_rgba(0,0,0,0.05),0_16px_48px_-12px_rgba(30,20,50,0.18))] backdrop-blur-md")}>
      <div className="rounded-[calc(14px*var(--admin-radius-scale,1))] bg-surface px-5 pt-6 pb-6 shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04))] sm:px-6">
        <div className="mb-6 flex flex-col gap-1">
          <h3 id="admin-style-title" className="text-[17px] font-semibold tracking-[-0.01em] text-ink/90">{c.title}</h3>
          <p className="text-[12px] text-ink/40">{c.subtitle}</p>
        </div>
        {/* 窄螢幕:預設風格 → 預覽 → 細部調整,調的時候預覽就在上面。
            寬螢幕:左邊控制、右邊預覽跟著捲動停在畫面裡。 */}
        <div className="grid min-w-0 gap-x-10 gap-y-7 [grid-template-areas:'presets'_'preview'_'controls'] xl:grid-cols-[minmax(300px,380px)_minmax(0,1fr)] xl:[grid-template-areas:'presets_preview'_'controls_preview']">
          <fieldset disabled={pending} className="min-w-0 [grid-area:presets]">
            <legend className="mb-3.5 text-[13px] font-medium text-ink/85">{c.presets}</legend>
            <div className="grid grid-cols-2 gap-2.5">
              {ADMIN_THEME_PRESETS.map((item) => {
                const active = preset?.id === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => change(item.appearance)}
                    className={cn(
                      "rounded-[calc(12px*var(--admin-radius-scale,1))] p-1.5 text-left transition-shadow duration-150 outline-none focus-visible:shadow-[0_0_0_2px_var(--admin-accent)]",
                      active ? "shadow-[0_0_0_1.5px_var(--admin-accent)]" : "shadow-[0_0_0_1px_rgba(0,0,0,0.08)] hover:shadow-[0_0_0_1px_rgba(0,0,0,0.18)]",
                    )}
                  >
                    <span aria-hidden className="flex h-14 gap-1.5 rounded-[8px] p-1.5" style={{ background: item.appearance.theme.background }}>
                      <span className="w-3.5 rounded-[3px]" style={{ background: item.appearance.accent }} />
                      <span className="flex-1 p-2 shadow-[0_0_0_1px_rgba(0,0,0,0.05)]" style={{ background: item.appearance.theme.surface, borderRadius: { sharp: 0, soft: 5, round: 9 }[item.appearance.theme.radius] }}>
                        <span className="block h-1.5 w-2/3 rounded-full opacity-60" style={{ background: item.appearance.theme.ink }} />
                        <span className="mt-2 block h-1 w-1/2 rounded-full opacity-20" style={{ background: item.appearance.theme.ink }} />
                      </span>
                    </span>
                    <span className="mt-1.5 flex items-center justify-between gap-1 px-1 pb-0.5 text-[12px] font-medium text-ink/80">
                      {item.name[locale]}
                      {active && <Check className="size-3.5 text-(--admin-accent)" aria-hidden />}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="min-w-0 [grid-area:preview] xl:sticky xl:top-6 xl:self-start">
            <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h4 className="text-[13px] font-medium text-ink/85">{c.preview}</h4>
              <p className="text-[12px] text-ink/40">{c.previewNote}</p>
            </div>
            <AdminThemePreview mode={previewMode} style={previewStyle} icons={preview.theme.icons} />
          </div>

          <fieldset disabled={pending} className="min-w-0 space-y-5 [grid-area:controls]">
            <legend className="sr-only">{c.title}</legend>
            <Group title={c.colors}>
              {/* 標籤在上:主色有九顆色票,並排會擠成兩行。 */}
              <div className="grid gap-3.5">
                {COLOR_KEYS.map((key) => (
                  <div key={key}>
                    <span aria-hidden className="mb-1 block text-[12px] text-ink/50">{c[key]}</span>
                    <ColorSwatchPicker
                      label={c[key]}
                      value={key === "accent" ? draft.accent : draft.theme[key]}
                      swatches={swatches[key]}
                      invalid={key === "ink" ? unreadable.length > 0 : key !== "accent" && unreadable.includes(key)}
                      onChange={(value) => (key === "accent" ? change({ ...draft, accent: value }) : setTheme({ [key]: value }))}
                    />
                  </div>
                ))}
              </div>
              {unreadable.length > 0 && (
                <p role="alert" className="mt-3 text-[12px] leading-relaxed text-red-600">
                  {c.unreadable(unreadable.map((key) => c[key]).join(c.and))}
                </p>
              )}
            </Group>
            <Group title={c.font}>
              <p id="theme-font-label" className="sr-only">{c.font}</p>
              <SettingTabs
                id="theme-font"
                labelledBy="theme-font-label"
                layout="list"
                value={draft.theme.font}
                tabs={ADMIN_FONTS.map((font) => ({ value: font.id, label: font.name[locale], labelStyle: { fontFamily: font.family } }))}
                onChange={(value) => setTheme({ font: value as AdminAppearance["theme"]["font"] })}
              />
            </Group>
            <Group title={c.shape}>
              <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3">
                {(["radius", "elevation"] as const).map((key) => (
                  <div key={key} className="contents">
                    <span id={`theme-${key}-label`} className="text-[12px] text-ink/50">{c[key]}</span>
                    <SettingTabs
                      id={`theme-${key}`}
                      labelledBy={`theme-${key}-label`}
                      value={draft.theme[key]}
                      tabs={SHAPE_OPTIONS[key].map((value) => ({ value, label: c[value] }))}
                      onChange={(value) => setTheme({ [key]: value })}
                    />
                  </div>
                ))}
              </div>
            </Group>
            <Group title={c.icons}>
              <p id="theme-icons-label" className="sr-only">{c.icons}</p>
              <SettingTabs
                id="theme-icons"
                labelledBy="theme-icons-label"
                value={draft.theme.icons}
                tabs={ADMIN_ICON_SETS.map((value) => ({ value, label: c[value] }))}
                onChange={(value) => setTheme({ icons: value as AdminAppearance["theme"]["icons"] })}
              />
            </Group>
          </fieldset>
        </div>
      </div>

      <SaveBar visible={barVisible} title={bar.title} note={bar.note} alert={failure !== null}>
        {dirty && !pending && (
          <button type="button" onClick={() => change(saved)} className={SAVE_BAR_SECONDARY_CLASS}>{c.discard}</button>
        )}
        <button type="submit" disabled={!dirty || !valid || pending} className={SAVE_BUTTON_CLASS}>
          <span>{pending ? c.saving : c.save}</span>
          {!pending && <span aria-hidden className="text-white/70">→</span>}
        </button>
      </SaveBar>
    </form>
  );
}
