"use client";

import { createElement, useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  Search,
  Check,
  Download,
  AlertCircle,
  Loader2,
  Sparkles,
  Images,
  FileText,
  Mail,
  ShoppingBag,
  CreditCard,
  Film,
  Clock,
  Braces,
  Package,
  type LucideIcon,
} from "lucide-react";
import { FluidTabs } from "@/components/ui/fluid-tabs";
import {
  StatusButton,
  type StatusButtonStatus,
} from "@/components/ui/status-button";
import { cn } from "@/lib/utils";
import { missingCapabilities } from "@/ext/features";
import { useT } from "@/lib/i18n/I18nProvider";
import { useInstallFlow, type InstallState } from "./useInstallFlow";
import { InstallPromptsDialog } from "./InstallPromptsDialog";

// Marketplace browse — App Store vibe: hero featured cards, category pills,
// search, deployment badges, Paper & Ink visual language.

interface RegistryEntry {
  id: string;
  kind: "declarative" | "code";
  name: string;
  version: string;
  coreApi: string;
  description?: string;
  author?: string;
  source: string;
  installed: boolean;
  installedVersion: string | null;
  compatible: boolean;
  icon?: string;
  iconUrl?: string;
  banner?: string;
  screenshots?: string[];
  license?: string;
  tags?: string[];
  category?: string;
  deployment?: "instant" | "progressive" | "code-only";
  homepage?: string;
  repository?: string;
  supportUrl?: string;
  capabilities?: string[];
  /** manifest.requires passthrough:服務需求(對照 IndexResponse.services 判定)。 */
  requires?: { capability: string; optional?: boolean; reason?: string }[];
}

interface SourceFetchError {
  source: string;
  error: string;
}

interface IndexResponse {
  entries: RegistryEntry[];
  errors: SourceFetchError[];
  /** 目前有 provider 的 capability 全集(requires 的滿足判定基準)。 */
  services?: string[];
  /** 編譯進 bundle 的 code extension(id/version = bundle 事實,enabled = DB 列)。 */
  installedCode?: { id: string; version: string; enabled: boolean }[];
}

// 基本分類 + registry entries 實際出現的 content category(動態附加 pills)
const BASE_CATEGORIES = ["all", "declarative", "code", "installed"] as const;
type Category = string;

type Translator = ReturnType<typeof useT>;

const DEPLOYMENT_BADGE_CLASS: Record<
  NonNullable<RegistryEntry["deployment"]>,
  string
> = {
  instant: "bg-green-600/10 text-green-700",
  progressive: "bg-[rgb(86,114,228)]/10 text-[rgb(86,114,228)]",
  "code-only": "bg-amber-500/15 text-amber-700",
};

function deploymentLabel(
  t: Translator,
  deployment: NonNullable<RegistryEntry["deployment"]>,
): string {
  if (deployment === "instant") return t("registryBrowser.deployment.instant");
  if (deployment === "progressive")
    return t("registryBrowser.deployment.progressive");
  return t("registryBrowser.deployment.codeOnly");
}

function DeploymentBadge({ entry }: { entry: RegistryEntry }) {
  const t = useT();
  if (!entry.deployment) return null;
  const className = DEPLOYMENT_BADGE_CLASS[entry.deployment];
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${className}`}
    >
      {deploymentLabel(t, entry.deployment)}
    </span>
  );
}

const HALO =
  "shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_16px_48px_-12px_rgba(30,20,50,0.18)]";
const CARD =
  "shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]";

// Resolve a relative media path (e.g. "icon.png") to a URL the browser can
// actually load. Registry sources can be private (Gitea token lives
// server-side in core.registryTokens) — the browser has no way to attach
// that token, so we never point <img> at the raw `<source>/extensions/<id>/…`
// URL directly. Instead this routes through the server-side proxy at
// /api/registry/asset, which fetches with the token and re-serves the bytes.
function mediaUrl(entry: RegistryEntry, relativePath?: string): string | null {
  if (!relativePath) return null;
  const params = new URLSearchParams({
    source: entry.source,
    id: entry.id,
    file: relativePath,
    // 快取 bust:asset route 帶 Cache-Control,以 version 入 key 讓改版必然換圖。
    v: entry.version,
  });
  return `/api/registry/asset?${params.toString()}`;
}

// Glyph per extension kind / id heuristic —— 向量線條 icon(lucide,同 sidebar
// 語彙),fallback 一律不用 emoji(Suko 紅線)。
function extGlyph(entry: RegistryEntry): LucideIcon {
  if (entry.id.includes("gallery") || entry.id.includes("photo")) return Images;
  if (entry.id.includes("blog") || entry.id.includes("post")) return FileText;
  if (entry.id.includes("contact") || entry.id.includes("form")) return Mail;
  if (entry.id.includes("shop") || entry.id.includes("store"))
    return ShoppingBag;
  if (entry.id.includes("payment") || entry.id.includes("pay"))
    return CreditCard;
  if (entry.id.includes("media")) return Film;
  if (entry.id.includes("cron") || entry.id.includes("schedule")) return Clock;
  if (entry.kind === "code") return Braces;
  return Package;
}

// 「字記 image」的底色:id 雜湊 → 固定選一組 Paper & Ink 友善的淺色漸層,
// 同一 extension 永遠同色(穩定的識別感),避免整排 featured 撞色。
const ART_TINTS: readonly [string, string][] = [
  ["#eef2ff", "#dfe6fb"], // 靛藍洗
  ["#ecfdf5", "#d5f5e3"], // 琢瑯綠洗
  ["#fff7ed", "#ffe9d1"], // 暖橙洗
  ["#fdf2f8", "#fbe3ef"], // 粉洗
  ["#f0f9ff", "#dcf1fc"], // 天藍洗
  ["#fefce8", "#fbf3c4"], // 稻黃洗
];
function artTint(id: string): readonly [string, string] {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return ART_TINTS[h % ART_TINTS.length];
}

// 玻璃質感 icon tile:上緣內光 + 白→透明縱向漸層 + 1px ring + 斜向 sheen。
// 克制版 glass(單一 sheen 層,無多層 glow)—— 對 img 與 emoji fallback 一致套用,
// 讓所有 extension icon 讀起來像同一套件。skeleton:img 未載入前 pulse 佔位,
// onLoad 淡入(asset route 有 Cache-Control 後,回訪多半直接命中不閃)。
function ExtIcon({
  entry,
  size = "default",
}: {
  entry: RegistryEntry;
  size?: "default" | "large";
}) {
  const iconUrl = mediaUrl(entry, entry.iconUrl);
  const [loaded, setLoaded] = useState(false);
  const dim =
    size === "large" ? "size-16 rounded-[16px]" : "size-11 rounded-[10px]";
  return (
    <div
      className={`relative isolate ${dim} shrink-0 overflow-hidden bg-gradient-to-b from-white/75 to-white/25 shadow-[inset_0_1px_0_rgba(255,255,255,0.95),inset_0_-1px_2px_rgba(0,0,0,0.05),0_0_0_1px_rgba(0,0,0,0.08),0_2px_6px_-2px_rgba(0,0,0,0.14)] backdrop-blur-[2px]`}
    >
      {iconUrl ? (
        <>
          {!loaded && (
            <div className="absolute inset-0 animate-pulse bg-black/[0.05]" />
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={iconUrl}
            alt={entry.name}
            onLoad={() => setLoaded(true)}
            className={`size-full object-cover transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
          />
        </>
      ) : (
        <div className="flex size-full items-center justify-center text-black/55">
          {/* createElement:extGlyph 回傳的是既有元件「參照」而非新元件,但
              react-hooks/static-components 分不出來 —— 走 createElement 繞誤報。 */}
          {createElement(extGlyph(entry), {
            className: size === "large" ? "size-7" : "size-5",
            strokeWidth: 1.75,
          })}
        </div>
      )}
      {/* 斜向光澤:transition-opacity 而非 all(規範);pointer-events 穿透。 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/40 via-white/0 to-transparent"
      />
    </div>
  );
}

// roadmap #17:entry.capabilities 裡「這個 core 不支援」的名稱,空陣列 = 相容。
function entryMissingCapabilities(entry: RegistryEntry): string[] {
  return missingCapabilities(entry.capabilities);
}

// manifest.requires:非 optional 且目前無 provider 的服務(空陣列 = 可安裝)。
function entryUnmetServices(
  entry: RegistryEntry,
  services: string[],
): string[] {
  const available = new Set(services);
  const unmet: string[] = [];
  for (const req of entry.requires ?? []) {
    if (req.optional || available.has(req.capability)) continue;
    if (!unmet.includes(req.capability)) unmet.push(req.capability);
  }
  return unmet;
}

// manifest id 允許連字號但 JS 識別字不行:import 名慣例 = camelCase(id)
// (extensions/<id>/index.ts 的 named export,同 szws-cms-cli-spec)。
function importIdent(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

// code extension 的安裝狀態:index route 本來就回 installed/installedVersion
// (extensions 表比對),UI 過去一律渲染死的「手動安裝」——這裡接上:
// 未裝 → 灰「手動安裝」;已裝同版 → 綠「已安裝」;已裝舊版 → 琥珀「可更新」。
type CodeState = "none" | "installed" | "update";
function codeEntryState(entry: RegistryEntry): CodeState {
  if (!entry.installed) return "none";
  return entry.installedVersion === entry.version ? "installed" : "update";
}

function CodeStateChip({
  entry,
  t,
  className,
}: {
  entry: RegistryEntry;
  t: Translator;
  className: string;
}) {
  const state = codeEntryState(entry);
  if (state === "installed") {
    return (
      <span
        className={cn(
          className,
          "bg-[rgba(16,145,90,0.10)] text-[rgb(18,124,88)] shadow-[inset_0_0_0_1px_rgba(16,145,90,0.16)]",
        )}
      >
        <Check className="size-3.5" />
        {t("registryBrowser.install.installed")}
      </span>
    );
  }
  if (state === "update") {
    return (
      <span
        className={cn(
          className,
          "bg-amber-500/10 text-amber-700 shadow-[inset_0_0_0_1px_rgba(217,119,6,0.18)]",
        )}
        title={`v${entry.installedVersion} → v${entry.version}`}
      >
        {t("registryBrowser.code.updateAvailable", { version: entry.version })}
      </span>
    );
  }
  return (
    <span className={cn(className, "bg-black/[0.04] text-black/40")}>
      {t("registryBrowser.install.manualInstall")}
    </span>
  );
}

function installLabel(
  t: Translator,
  state: InstallState,
  isUpdate: boolean,
): string {
  if (state === "installing")
    return isUpdate
      ? t("registryBrowser.install.updating")
      : t("registryBrowser.install.installing");
  if (state === "installed") return t("registryBrowser.install.installed");
  if (state === "failed") return t("registryBrowser.install.retry");
  return isUpdate
    ? t("registryBrowser.install.update")
    : t("registryBrowser.install.get");
}

// Map the install-flow state onto the vendored StatusButton's status API.
function statusFromInstall(state: InstallState): StatusButtonStatus {
  if (state === "installing") return "loading";
  if (state === "installed") return "success";
  if (state === "failed") return "error";
  return "idle";
}

function FeaturedCard({
  entry,
  onClick,
  onInstalled,
}: {
  entry: RegistryEntry;
  onClick: () => void;
  onInstalled: (id: string) => void;
}) {
  const t = useT();
  const { state, error, prompts, install, submitPrompts, closePrompts } =
    useInstallFlow(entry, onInstalled);
  const missing = entryMissingCapabilities(entry);
  const bannerUrl = mediaUrl(entry, entry.banner ?? entry.screenshots?.[0]);
  const [tintA, tintB] = artTint(entry.id);

  return (
    <div
      onClick={onClick}
      className={`relative cursor-pointer overflow-hidden rounded-[20px] bg-white p-1.5 transition-[box-shadow] duration-150 hover:shadow-[0_0_0_1px_rgba(86,114,228,0.2),0_16px_48px_-12px_rgba(30,20,50,0.22)] ${HALO}`}
    >
      {/* 長圖主視覺 + 同心 nest:外殼 20px、p-1.5(6px)→ 內框 14px(concentric)。
          banner 有真圖用真圖;沒有就用「字記 image」—— id 雜湊出穩定色調,
          大字名稱當主視覺、超大 glyph 當水印。icon/名稱/安裝動作固定在圖底
          的 glass bar(editorial 慣例:artwork 說故事,bar 負責身分與行動)。 */}
      <div className={`relative overflow-hidden rounded-[14px] ${CARD}`}>
        {bannerUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={bannerUrl}
            alt=""
            className="aspect-[5/2] w-full object-cover md:aspect-[3/1]"
          />
        ) : (
          <div
            className="relative aspect-[5/2] w-full overflow-hidden md:aspect-[3/1]"
            style={{
              backgroundImage: `linear-gradient(135deg, ${tintA}, ${tintB})`,
            }}
          >
            <div className="flex h-full flex-col gap-1.5 p-6 pb-20 pr-28">
              <span className="text-balance text-[clamp(22px,3.2vw,32px)] font-bold leading-tight tracking-[-0.02em] text-black/85">
                {entry.name}
              </span>
              {entry.description && (
                <span className="line-clamp-2 max-w-[560px] text-[13px] leading-relaxed text-black/45">
                  {entry.description}
                </span>
              )}
            </div>
            {/* createElement 繞 static-components 誤報(同 ExtIcon 註解)。 */}
            {createElement(extGlyph(entry), {
              "aria-hidden": true,
              strokeWidth: 1,
              className: "absolute -bottom-8 -right-6 size-40 text-black/[0.07]",
            })}
          </div>
        )}
        {/* 圖底固定 bar:glass。 */}
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 border-t border-black/[0.05] bg-white/75 px-4 py-2.5 backdrop-blur-md">
          <ExtIcon entry={entry} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-black/90">
              {entry.name}
            </span>
            <span className="flex items-center gap-2 text-[11px] text-black/45">
              v{entry.version} · {kindLabel(t, entry.kind)}
              {entry.installed && (
                <span className="inline-flex items-center gap-1 rounded-full bg-[rgb(86,114,228)]/10 px-2 py-0.5 font-medium text-[rgb(86,114,228)]">
                  <Check className="size-3" />
                  {t("registryBrowser.install.installed")}
                </span>
              )}
            </span>
          </div>
          <div className="shrink-0">
            {entry.kind === "code" ? (
              <CodeStateChip
                entry={entry}
                t={t}
                className="inline-flex h-9 items-center gap-1.5 rounded-[8px] px-4 text-[13px] font-medium"
              />
            ) : !entry.compatible ? (
              <div className="flex flex-col items-end gap-1">
                <button
                  type="button"
                  disabled
                  className="inline-flex h-9 items-center rounded-[8px] bg-black/[0.06] px-4 text-[13px] font-medium text-black/35"
                >
                  {t("registryBrowser.install.install")}
                </button>
                <span className="text-[10px] text-red-600/70">
                  {t("registryBrowser.install.requiresCore", {
                    core: entry.coreApi,
                  })}
                </span>
              </div>
            ) : missing.length > 0 ? (
              <div className="flex flex-col items-end gap-1">
                <button
                  type="button"
                  disabled
                  className="inline-flex h-9 items-center rounded-[8px] bg-black/[0.06] px-4 text-[13px] font-medium text-black/35"
                >
                  {t("registryBrowser.install.install")}
                </button>
                <span className="text-[10px] text-red-600/70">
                  {t("registryBrowser.install.needsFeatures", {
                    features: missing.join(", "),
                  })}
                </span>
              </div>
            ) : (
              // stopPropagation:卡片本身 onClick 會開 detail 頁,包一層擋住冒泡,
              // 讓 Install 按鈕只做安裝、不順帶開頁(沿用原 FeaturedCard 行為)。
              <div onClick={(e) => e.stopPropagation()}>
                <StatusButton
                  size="md"
                  status={statusFromInstall(state)}
                  label={installLabel(t, state, false)}
                  idleIcon={<Download className="size-3.5" />}
                  onClick={() => void install()}
                />
              </div>
            )}
          </div>
        </div>
      </div>
      {prompts && (
        // stopPropagation:card 本身有 onClick(開 detail 頁);Dialog 走 Portal,
        // DOM 位置在 body 底下,但 React 合成事件仍沿 fiber tree 冒泡 —— 沒擋住的話
        // 在表單裡點擊會意外觸發卡片的 onClick,把整張卡(含這個 Dialog)卸載掉。
        <div onClick={(e) => e.stopPropagation()}>
          <InstallPromptsDialog
            extensionName={entry.name}
            prompts={prompts}
            submitting={state === "installing"}
            error={error}
            onCancel={closePrompts}
            onSubmit={(values) => void submitPrompts(values)}
          />
        </div>
      )}
    </div>
  );
}

function kindLabel(t: Translator, kind: "declarative" | "code"): string {
  return kind === "declarative"
    ? t("registryBrowser.kind.declarative")
    : t("registryBrowser.kind.code");
}

function categoryLabel(t: Translator, category: string): string {
  if (category === "all") return t("registryBrowser.category.all");
  if (category === "declarative")
    return t("registryBrowser.category.declarative");
  if (category === "code") return t("registryBrowser.category.code");
  if (category === "installed") return t("registryBrowser.category.installed");
  // 動態 content category 來自 registry 資料,沿用 capitalize 顯示
  return category.charAt(0).toUpperCase() + category.slice(1);
}

function StoreCard({
  entry,
  onClick,
  onInstalled,
}: {
  entry: RegistryEntry;
  onClick: () => void;
  onInstalled: (id: string) => void;
}) {
  const t = useT();
  const { state, error, prompts, install, submitPrompts, closePrompts } =
    useInstallFlow(entry, onInstalled);
  const missing = entryMissingCapabilities(entry);

  const isUpdate =
    entry.installed &&
    entry.installedVersion !== null &&
    entry.installedVersion !== entry.version;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ type: "spring", stiffness: 300, damping: 25 }}
      onClick={onClick}
      className={`group flex cursor-pointer flex-col gap-3 rounded-[14px] bg-white p-4 ${CARD} transition-[box-shadow] duration-150 hover:shadow-[0_0_0_1px_rgba(0,0,0,0.1),0_4px_12px_-2px_rgba(0,0,0,0.08)]`}
    >
      {/* header */}
      <div className="flex items-start gap-3">
        <ExtIcon entry={entry} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[14px] font-semibold text-black/85">
            {entry.name}
          </span>
          <span className="line-clamp-2 text-[12px] leading-relaxed text-black/45">
            {entry.description ?? t("registryBrowser.noDescription")}
          </span>
        </div>
      </div>
      {/* meta + badges */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-black/[0.04] px-2 py-0.5 text-[10px] font-medium text-black/45">
          {kindLabel(t, entry.kind)}
        </span>
        {entry.category && (
          <span className="rounded-full bg-black/[0.04] px-2 py-0.5 text-[10px] font-medium capitalize text-black/45">
            {entry.category}
          </span>
        )}
        <DeploymentBadge entry={entry} />
        <span className="text-[10px] text-black/35">v{entry.version}</span>
        {entry.author && (
          <span className="text-[10px] text-black/35">· {entry.author}</span>
        )}
      </div>
      {/* action */}
      <div className="flex items-center justify-between pt-1">
        {error && (
          <span className="flex items-center gap-1 text-[11px] text-red-600">
            <AlertCircle className="size-3" />
            {error}
          </span>
        )}
        <div className="ml-auto">
          {entry.kind === "code" ? (
            <CodeStateChip
              entry={entry}
              t={t}
              className="inline-flex h-7 items-center gap-1 rounded-[6px] px-3 text-[11px] font-medium"
            />
          ) : !entry.compatible ? (
            <span className="text-[11px] text-red-600/70">
              {t("registryBrowser.install.requiresCore", {
                core: entry.coreApi,
              })}
            </span>
          ) : missing.length > 0 ? (
            <span className="text-[11px] text-red-600/70">
              {t("registryBrowser.install.needsFeatures", {
                features: missing.join(", "),
              })}
            </span>
          ) : (
            // stopPropagation:同 FeaturedCard —— 卡片 onClick 會開 detail 頁,
            // 少了這層的話按 Get/Update 會順帶切頁,安裝流程看起來像沒觸發。
            <div onClick={(e) => e.stopPropagation()}>
              <StatusButton
                size="sm"
                variant={isUpdate ? "soft" : "solid"}
                status={statusFromInstall(state)}
                label={installLabel(t, state, isUpdate)}
                idleIcon={
                  isUpdate ? undefined : <Download className="size-3" />
                }
                onClick={() => void install()}
              />
            </div>
          )}
        </div>
      </div>
      {prompts && (
        <div onClick={(e) => e.stopPropagation()}>
          <InstallPromptsDialog
            extensionName={entry.name}
            prompts={prompts}
            submitting={state === "installing"}
            error={error}
            onCancel={closePrompts}
            onSubmit={(values) => void submitPrompts(values)}
          />
        </div>
      )}
    </motion.div>
  );
}

export function RegistryBrowser() {
  const t = useT();
  const [data, setData] = useState<IndexResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const [selectedEntry, setSelectedEntry] = useState<RegistryEntry | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetch("/api/registry/index");
        if (!res.ok) {
          if (!cancelled) setLoadError(t("registryBrowser.loadError"));
          return;
        }
        const json = (await res.json()) as IndexResponse;
        // code entry 的 installed/installedVersion 以 installedCode(bundle 事實,
        // extensions/registry.ts 編譯進來的版本)覆蓋 DB 列版本 —— DB 可能落後
        // (registry.ts 加了項但沒跑 install)或超前(row 在、code 已移除)。
        // 單點覆蓋,下游 CodeStateChip / installed 分類全部自動吃到。
        const codeById = new Map(
          (json.installedCode ?? []).map((c) => [c.id, c]),
        );
        const entries = json.entries.map((e) => {
          if (e.kind !== "code") return e;
          const bundled = codeById.get(e.id);
          return {
            ...e,
            installed: bundled !== undefined,
            installedVersion: bundled?.version ?? null,
          };
        });
        if (!cancelled) setData({ ...json, entries });
      } catch {
        if (!cancelled) setLoadError(t("registryBrowser.networkError"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // t 來自 useT,本身隨 provider re-render 而變;這裡只想在 mount 時拉一次
    // /api/registry/index,刻意排除 t 避免重新 fetch。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // registry entries 實際帶的 content category → 動態附加成 pills
  const contentCategories = useMemo(() => {
    if (!data) return [];
    const seen = new Set<string>();
    for (const e of data.entries) if (e.category) seen.add(e.category);
    return [...seen].sort();
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    let list = data.entries;
    if (category === "declarative") {
      list = list.filter((e) => e.kind === "declarative");
    } else if (category === "code") {
      list = list.filter((e) => e.kind === "code");
    } else if (category === "installed") {
      list = list.filter((e) => e.installed);
    } else if (category !== "all") {
      list = list.filter((e) => e.category === category);
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.id.toLowerCase().includes(q) ||
          e.description?.toLowerCase().includes(q) ||
          e.category?.toLowerCase().includes(q) ||
          e.tags?.some((t) => t.toLowerCase().includes(q)),
      );
    }
    return list;
  }, [data, category, query]);

  const featured = useMemo(() => {
    if (!data) return [];
    // Featured = first 2 entries that are compatible and not installed
    return data.entries.filter((e) => e.compatible && !e.installed).slice(0, 2);
  }, [data]);

  // 安裝/更新成功 → 就地更新 client 端的 registry data(installedVersion 對齊 registry
  // 版本),列表卡、detail 頁、featured 全部即時反映;不等重新 fetch /api/registry/index。
  const handleInstalled = useCallback((id: string) => {
    const mark = (e: RegistryEntry): RegistryEntry =>
      e.id === id ? { ...e, installed: true, installedVersion: e.version } : e;
    setData((prev) =>
      prev ? { ...prev, entries: prev.entries.map(mark) } : prev,
    );
    setSelectedEntry((prev) => (prev ? mark(prev) : prev));
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="size-6 animate-spin text-black/30" />
          <span className="text-[13px] text-black/35">
            {t("registryBrowser.loading")}
          </span>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-[14px] border border-red-600/20 bg-red-50 p-6 text-center">
        <AlertCircle className="mx-auto size-6 text-red-600/60" />
        <p className="mt-2 text-[14px] font-medium text-red-700">{loadError}</p>
      </div>
    );
  }

  if (!data) return null;

  // Detail view
  if (selectedEntry) {
    return (
      <ExtensionDetail
        entry={selectedEntry}
        services={data.services ?? []}
        onBack={() => setSelectedEntry(null)}
        onInstalled={handleInstalled}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Errors */}
      {data.errors.length > 0 && (
        <div className="flex flex-col gap-1 rounded-[10px] border border-red-600/15 bg-red-50 px-4 py-3">
          {data.errors.map((e) => (
            <p key={e.source} className="text-[12px] text-red-700">
              {e.source}: {e.error}
            </p>
          ))}
        </div>
      )}

      {/* Featured */}
      {featured.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-[rgb(86,114,228)]" />
            <span className="text-[14px] font-semibold tracking-[-0.01em] text-black/85">
              {t("registryBrowser.featured")}
            </span>
          </div>
          <div className="flex flex-col gap-3">
            {featured.map((entry) => (
              <FeaturedCard
                key={`f-${entry.source}:${entry.id}`}
                entry={entry}
                onClick={() => setSelectedEntry(entry)}
                onInstalled={handleInstalled}
              />
            ))}
          </div>
        </div>
      )}

      {/* Search + Category */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 rounded-[10px] border border-black/10 bg-white px-3 py-2 shadow-[0_0_0_1px_rgba(0,0,0,0.04)]">
          <Search className="size-4 shrink-0 text-black/35" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("registryBrowser.searchPlaceholder")}
            className="w-full bg-transparent text-[14px] text-black/85 outline-none placeholder:text-black/30"
          />
        </div>

        <div className="flex justify-center">
          <FluidTabs
            compact
            tabs={[
              { id: "all", label: categoryLabel(t, "all") },
              { id: "declarative", label: categoryLabel(t, "declarative") },
              { id: "code", label: categoryLabel(t, "code") },
              { id: "installed", label: categoryLabel(t, "installed") },
              ...contentCategories.map((c) => ({
                id: c,
                label: c.charAt(0).toUpperCase() + c.slice(1),
              })),
            ]}
            defaultActive="all"
            onChange={(id) =>
              setCategory(
                (BASE_CATEGORIES as readonly string[]).includes(id) ||
                  contentCategories.includes(id)
                  ? id
                  : "all",
              )
            }
          />
        </div>
      </div>

      {/* Count */}
      <p className="text-[13px] text-black/40">
        {filtered.length === 1
          ? t("registryBrowser.extensionCount.one")
          : t("registryBrowser.extensionCount.other", { n: filtered.length })}
        {category !== "all" &&
          t("registryBrowser.countInCategory", {
            category: categoryLabel(t, category),
          })}
      </p>

      {/* Grid */}
      {filtered.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-black/20 p-10 text-center">
          <p className="text-[14px] font-medium text-black/45">
            {t("registryBrowser.empty.title")}
          </p>
          <p className="mt-1 text-[12px] text-black/30">
            {query
              ? t("registryBrowser.empty.noResultsFor", { query })
              : t("registryBrowser.empty.checkSources")}
          </p>
        </div>
      ) : (
        <motion.div
          layout
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          {filtered.map((entry) => (
            <StoreCard
              key={`${entry.source}:${entry.id}`}
              entry={entry}
              onClick={() => setSelectedEntry(entry)}
              onInstalled={handleInstalled}
            />
          ))}
        </motion.div>
      )}
    </div>
  );
}

function ExtensionDetail({
  entry,
  services,
  onBack,
  onInstalled,
}: {
  entry: RegistryEntry;
  services: string[];
  onBack: () => void;
  onInstalled: (id: string) => void;
}) {
  const t = useT();
  const { state, error, prompts, install, submitPrompts, closePrompts } =
    useInstallFlow(entry, onInstalled);
  const missing = entryMissingCapabilities(entry);
  const unmetServices = entryUnmetServices(entry, services);
  const bannerUrl = mediaUrl(entry, entry.banner);
  const screenshots = (entry.screenshots ?? [])
    .map((s) => mediaUrl(entry, s))
    .filter((u): u is string => u !== null);

  const isUpdate =
    entry.installed &&
    entry.installedVersion !== null &&
    entry.installedVersion !== entry.version;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 280, damping: 26 }}
      className="flex flex-col gap-6"
    >
      {/* Back */}
      <button
        type="button"
        onClick={onBack}
        className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-black/45 transition-colors hover:text-black/85"
      >
        ← {t("registryBrowser.detail.back")}
      </button>

      {/* Banner */}
      <div className="relative -mx-4 -mt-4 overflow-hidden rounded-b-[14px] lg:-mx-6 lg:-mt-6">
        <div className="relative h-[160px] w-full sm:h-[220px]">
          {bannerUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={bannerUrl}
              alt=""
              className="size-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div
              className="size-full"
              style={{
                backgroundImage: `linear-gradient(135deg, oklch(0.92 0.05 250), oklch(0.88 0.08 290))`,
              }}
            />
          )}
          {/* gradient overlay for text readability */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent" />
        </div>
      </div>

      {/* Header: icon + name + version + install */}
      <div className="flex items-start gap-4">
        <ExtIcon entry={entry} size="large" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="text-[24px] font-bold tracking-[-0.02em] text-black/90">
            {entry.name}
          </h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-black/45">
            <span>{kindLabel(t, entry.kind)}</span>
            <span>·</span>
            <span>v{entry.version}</span>
            {entry.author && (
              <>
                <span>·</span>
                <span>
                  {t("registryBrowser.detail.byAuthor", {
                    author: entry.author,
                  })}
                </span>
              </>
            )}
            {entry.license && (
              <>
                <span>·</span>
                <span>{entry.license}</span>
              </>
            )}
            {entry.category && (
              <span className="rounded-full bg-black/[0.04] px-2 py-0.5 text-[11px] font-medium capitalize text-black/45">
                {entry.category}
              </span>
            )}
            <DeploymentBadge entry={entry} />
          </div>
        </div>
        <div className="shrink-0">
          {entry.kind === "code" ? (
            <CodeStateChip
              entry={entry}
              t={t}
              className="inline-flex h-10 items-center gap-1.5 rounded-[8px] px-4 text-[13px] font-medium"
            />
          ) : !entry.compatible ? (
            <span className="text-[12px] text-red-600/70">
              {t("registryBrowser.install.requiresCore", {
                core: entry.coreApi,
              })}
            </span>
          ) : missing.length > 0 ? (
            <span className="text-[12px] text-red-600/70">
              {t("registryBrowser.install.needsFeatures", {
                features: missing.join(", "),
              })}
            </span>
          ) : unmetServices.length > 0 ? (
            <span className="text-[12px] text-red-600/70">
              {t("registryBrowser.install.needsServices", {
                services: unmetServices.join(", "),
              })}
            </span>
          ) : (
            <StatusButton
              size="lg"
              variant={isUpdate ? "soft" : "solid"}
              status={statusFromInstall(state)}
              label={installLabel(t, state, isUpdate)}
              idleIcon={isUpdate ? undefined : <Download className="size-4" />}
              onClick={() => void install()}
            />
          )}
        </div>
      </div>

      {prompts && (
        <InstallPromptsDialog
          extensionName={entry.name}
          prompts={prompts}
          submitting={state === "installing"}
          error={error}
          onCancel={closePrompts}
          onSubmit={(values) => void submitPrompts(values)}
        />
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 rounded-[8px] bg-red-50 px-3 py-2 text-[13px] text-red-700">
          <AlertCircle className="size-4" />
          {error}
        </div>
      )}

      {/* Description */}
      {entry.description && (
        <div className={`rounded-[14px] bg-white px-6 py-5 ${CARD}`}>
          <h2 className="mb-2 text-[15px] font-semibold tracking-[-0.01em] text-black/85">
            {t("registryBrowser.detail.about")}
          </h2>
          <p className="text-[14px] leading-relaxed text-black/65">
            {entry.description}
          </p>
        </div>
      )}

      {/* Manual install (code kind):cards 上的灰標籤只給視覺提示,
          真實步驟放這裡。canonical 安裝指令為 `npx @sz.ws/cms add <id>`(cli/)。
          import 識別字:manifest id 允許連字號,但 JS 識別字不行 —— 慣例為
          camelCase(id) 的 named export(同 szws-cms-cli-spec)。 */}
      {entry.kind === "code" && (
        <div className={`rounded-[14px] bg-white px-6 py-5 ${CARD}`}>
          <h2 className="mb-2 text-[15px] font-semibold tracking-[-0.01em] text-black/85">
            {t("registryBrowser.manualInstall.title")}
          </h2>
          <p className="mb-4 text-[13px] leading-relaxed text-black/55">
            {t("registryBrowser.manualInstall.intro")}
          </p>
          <ol className="mb-4 flex flex-col gap-2 text-[13px] leading-relaxed text-black/65">
            <li className="flex gap-2">
              <span className="shrink-0 font-mono text-black/35">1.</span>
              <span>{t("registryBrowser.manualInstall.step1")}</span>
            </li>
            <li className="flex gap-2">
              <span className="shrink-0 font-mono text-black/35">2.</span>
              <span>
                {t("registryBrowser.manualInstall.step2", { id: entry.id })}
              </span>
            </li>
            <li className="flex gap-2">
              <span className="shrink-0 font-mono text-black/35">3.</span>
              <span>
                {t("registryBrowser.manualInstall.step3Prefix")}
                <code className="mx-1 rounded bg-black/[0.06] px-1.5 py-0.5 font-mono text-[12px] text-black/80">
                  {`import { ${importIdent(entry.id)} } from "./${entry.id}";`}
                </code>
                {t("registryBrowser.manualInstall.step3Suffix")}
              </span>
            </li>
            <li className="flex gap-2">
              <span className="shrink-0 font-mono text-black/35">4.</span>
              <span>{t("registryBrowser.manualInstall.step4")}</span>
            </li>
          </ol>
          <div className="rounded-[10px] bg-black/[0.04] px-4 py-3">
            <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-black/45">
              {t("registryBrowser.manualInstall.canonicalLabel")}
            </div>
            <code className="block font-mono text-[13px] text-black/85">
              npx @sz.ws/cms add {entry.id}
            </code>
            <div className="mt-1 text-[11.5px] text-black/40">
              {t("registryBrowser.manualInstall.canonicalNote")}
            </div>
          </div>
          {entry.repository && (
            <div className="mt-3 flex flex-wrap items-baseline gap-2 text-[12.5px]">
              <span className="text-black/50">
                {t("registryBrowser.manualInstall.repoLabel")}:
              </span>
              <a
                href={entry.repository}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate text-[rgb(86,114,228)] hover:underline"
              >
                {entry.repository.replace(/^https?:\/\//, "")}
              </a>
            </div>
          )}
        </div>
      )}

      {/* Requires:capability chips(core 版本功能,roadmap #17)+ 服務需求 chips
          (manifest.requires:provider 在場與否 — met 綠 / unmet 紅 / optional 缺席琥珀)。 */}
      {((entry.capabilities ?? []).length > 0 ||
        (entry.requires ?? []).length > 0) && (
        <div className={`rounded-[14px] bg-white px-6 py-5 ${CARD}`}>
          <h2 className="mb-2 text-[15px] font-semibold tracking-[-0.01em] text-black/85">
            {t("registryBrowser.detail.requires")}
          </h2>
          <div className="flex flex-wrap items-center gap-1.5">
            {(entry.capabilities ?? []).map((cap) => {
              const unsupported = missing.includes(cap);
              return (
                <span
                  key={cap}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium",
                    unsupported
                      ? "bg-red-600/10 text-red-700"
                      : "bg-black/[0.04] text-black/50",
                  )}
                  title={
                    unsupported
                      ? t("registryBrowser.detail.notSupportedTitle")
                      : undefined
                  }
                >
                  {cap}
                  {unsupported && (
                    <span className="text-red-600/70">
                      {t("registryBrowser.detail.notSupportedBadge")}
                    </span>
                  )}
                </span>
              );
            })}
            {(entry.requires ?? []).map((req) => {
              const met = services.includes(req.capability);
              const tone = met
                ? "bg-[rgba(16,145,90,0.10)] text-[rgb(18,124,88)] shadow-[inset_0_0_0_1px_rgba(16,145,90,0.16)]"
                : req.optional
                  ? "bg-amber-500/10 text-amber-700 shadow-[inset_0_0_0_1px_rgba(217,119,6,0.18)]"
                  : "bg-red-600/10 text-red-700 shadow-[inset_0_0_0_1px_rgba(220,38,38,0.16)]";
              const badge = met
                ? t("registryBrowser.detail.serviceProvided")
                : req.optional
                  ? t("registryBrowser.detail.serviceOptional")
                  : t("registryBrowser.detail.serviceMissing");
              return (
                <span
                  key={`svc-${req.capability}`}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium",
                    tone,
                  )}
                  title={req.reason}
                >
                  {req.capability}
                  <span className="opacity-70">· {badge}</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Screenshots */}
      {screenshots.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-black/85">
            {t("registryBrowser.detail.screenshots")}
          </h2>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {screenshots.map((url, i) => (
              <div
                key={i}
                className="relative aspect-[16/10] w-[400px] shrink-0 overflow-hidden rounded-[12px] shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_8px_-2px_rgba(0,0,0,0.08)]"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt={`Screenshot ${i + 1}`}
                  className="size-full object-cover"
                  loading="lazy"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tags */}
      {(entry.tags ?? []).length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {entry.tags!.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-black/[0.04] px-2.5 py-1 text-[11px] font-medium text-black/50"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Links */}
      {(entry.homepage || entry.repository || entry.supportUrl) && (
        <div
          className={`flex flex-col gap-2 rounded-[14px] bg-white px-6 py-4 ${CARD}`}
        >
          {entry.homepage && (
            <div className="flex items-center justify-between text-[13px]">
              <span className="font-medium text-black/55">
                {t("registryBrowser.detail.link.homepage")}
              </span>
              <a
                href={entry.homepage}
                target="_blank"
                rel="noopener noreferrer"
                className="max-w-[60%] truncate text-[rgb(86,114,228)] hover:underline"
              >
                {entry.homepage.replace(/^https:\/\//, "")}
              </a>
            </div>
          )}
          {entry.repository && (
            <div className="flex items-center justify-between text-[13px]">
              <span className="font-medium text-black/55">
                {t("registryBrowser.detail.link.repository")}
              </span>
              <a
                href={entry.repository}
                target="_blank"
                rel="noopener noreferrer"
                className="max-w-[60%] truncate text-[rgb(86,114,228)] hover:underline"
              >
                {entry.repository.replace(/^https:\/\//, "")}
              </a>
            </div>
          )}
          {entry.supportUrl && (
            <div className="flex items-center justify-between text-[13px]">
              <span className="font-medium text-black/55">
                {t("registryBrowser.detail.link.support")}
              </span>
              <a
                href={entry.supportUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="max-w-[60%] truncate text-[rgb(86,114,228)] hover:underline"
              >
                {entry.supportUrl.replace(/^https:\/\//, "")}
              </a>
            </div>
          )}
        </div>
      )}

      {/* Compatibility info */}
      <div className={`rounded-[14px] bg-white px-6 py-4 ${CARD}`}>
        <div className="flex items-center justify-between text-[13px]">
          <span className="font-medium text-black/55">
            {t("registryBrowser.detail.compatibility")}
          </span>
          <span
            className={entry.compatible ? "text-green-600" : "text-red-600"}
          >
            {entry.compatible
              ? t("registryBrowser.detail.compatible")
              : t("registryBrowser.detail.requiresCoreApi", {
                  core: entry.coreApi,
                })}
          </span>
        </div>
      </div>
    </motion.div>
  );
}
