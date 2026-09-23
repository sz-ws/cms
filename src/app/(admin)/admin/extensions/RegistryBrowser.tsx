"use client";

import {
  createElement,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion } from "motion/react";
import {
  Search,
  Check,
  Download,
  AlertCircle,
  Sparkles,
  ChevronLeft,
  ChevronRight,
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
import { LoadingState } from "@/components/admin/LoadingState";
import { missingCapabilities } from "@/ext/features";
import { useLocale, useT } from "@/lib/i18n/I18nProvider";
import { useInstallFlow, type InstallState } from "./useInstallFlow";
import { InstallPromptsDialog } from "./InstallPromptsDialog";
import { ScriptReviewDialog } from "./ScriptReviewDialog";
import {
  entryUnmetPlugins,
  markInstalled,
  type IndexResponse,
  type InstalledPluginRef,
  type RegistryEntry,
} from "./registry-types";
import { InstallGate, RequiredPluginItems, UsedBySection, requiredPluginName } from "./PluginRequirements";

// Marketplace browse — App Store vibe: hero featured cards, category pills,
// search, deployment badges, Paper & Ink visual language.

// 基本分類 + registry entries 實際出現的 content category(動態附加 pills)
const BASE_CATEGORIES = ["all", "declarative", "code", "installed"] as const;
type Category = string;

type Translator = ReturnType<typeof useT>;

const DEPLOYMENT_BADGE_CLASS: Record<
  NonNullable<RegistryEntry["deployment"]>,
  string
> = {
  instant: "bg-green-600/10 text-green-700",
  progressive: "bg-(--admin-accent)/10 text-(--admin-accent)",
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
  "shadow-[var(--admin-shadow-panel,0_0_0_1px_rgba(0,0,0,0.05),0_16px_48px_-12px_rgba(30,20,50,0.18))]";
const CARD =
  "shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04))]";

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
    size === "large" ? "size-16 rounded-[calc(16px*var(--admin-radius-scale,1))]" : "size-11 rounded-[calc(10px*var(--admin-radius-scale,1))]";
  return (
    <div
      className={`relative isolate ${dim} shrink-0 overflow-hidden bg-gradient-to-b from-white/75 to-white/25 shadow-[inset_0_1px_0_rgba(255,255,255,0.95),inset_0_-1px_2px_rgba(0,0,0,0.05),0_0_0_1px_rgba(0,0,0,0.08),0_2px_6px_-2px_rgba(0,0,0,0.14)] backdrop-blur-[2px]`}
    >
      {iconUrl ? (
        <>
          {!loaded && (
            <div className="absolute inset-0 animate-pulse bg-ink/[0.05]" />
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
        <div className="flex size-full items-center justify-center text-ink/55">
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

// 1.50.0:卡片上不能直接裝的理由(同 id 已是別的插件、舊版從別的來源裝、缺必要插件)。
// 卡片只給一句短的,完整說明與「前往」在詳情頁。null = 可以畫安裝鈕。
function cardBlockLabel(
  t: Translator,
  entry: RegistryEntry,
  installed: ReadonlyMap<string, InstalledPluginRef>,
): string | null {
  if (entry.kind !== "declarative") return null;
  if (entry.conflict === "identity" || entry.conflict === "kind") return t("registryBrowser.plugins.conflictShort");
  if (entry.conflict === "source") return t("registryBrowser.plugins.otherSourceShort");
  // 已經裝好、沒有新版:卡片照舊顯示「已安裝」,缺的插件在詳情頁與已安裝列表上說。
  if (entry.installed && entry.installedVersion === entry.version) return null;
  if (entryUnmetPlugins(entry, installed).length > 0) return t("registryBrowser.plugins.needsShort");
  return null;
}

// code extension 的安裝狀態:index route 本來就回 installed/installedVersion
// (extensions 表比對),UI 過去一律渲染死的「手動安裝」——這裡接上:
// 未裝 → 灰「開發者安裝」(管理員自己裝不了,詳情頁底下再一句話說誰來做);
// 已裝同版 → 綠「已安裝」;已裝舊版 → 琥珀「可更新」。
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
    <span className={cn(className, "bg-ink/[0.04] text-ink/40")}>
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
  blocked,
  nameOf,
  onClick,
  onInstalled,
}: {
  entry: RegistryEntry;
  /** 1.50.0:不能直接裝的理由(見 cardBlockLabel);有就不畫安裝鈕。 */
  blocked: string | null;
  /** 1.50.0:必要插件的顯示名稱(安裝失敗的訊息用)。 */
  nameOf: (id: string) => string;
  onClick: () => void;
  onInstalled: (id: string, source: string) => void;
}) {
  const t = useT();
  const {
    state,
    error,
    prompts,
    install,
    submitPrompts,
    closePrompts,
    review,
    confirmReview,
    closeReview,
  } = useInstallFlow(entry, onInstalled, nameOf);
  const missing = entryMissingCapabilities(entry);
  const bannerUrl = mediaUrl(entry, entry.banner ?? entry.screenshots?.[0]);
  const [tintA, tintB] = artTint(entry.id);

  return (
    <div
      onClick={onClick}
      className={`relative cursor-pointer overflow-hidden rounded-[calc(20px*var(--admin-radius-scale,1))] bg-surface p-1.5 transition-[box-shadow] duration-150 hover:shadow-[0_0_0_1px_color-mix(in_srgb,var(--admin-accent)_20%,transparent),0_16px_48px_-12px_rgba(30,20,50,0.22)] ${HALO}`}
    >
      {/* 長圖主視覺 + 同心 nest:外殼 20px、p-1.5(6px)→ 內框 14px(concentric)。
          banner 有真圖用真圖;沒有就用「字記 image」—— id 雜湊出穩定色調,
          大字名稱當主視覺、超大 glyph 當水印。icon/名稱/安裝動作固定在圖底
          的 glass bar(editorial 慣例:artwork 說故事,bar 負責身分與行動)。 */}
      <div className={`relative overflow-hidden rounded-[calc(14px*var(--admin-radius-scale,1))] ${CARD}`}>
        {bannerUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={bannerUrl}
            alt=""
            className="aspect-[5/2] w-full min-h-52 object-cover md:aspect-[3/1]"
          />
        ) : (
          <div
            // min-h-52:`md:aspect-[3/1]` 的 md 看的是**視窗**寬度而不是卡片寬度。
            // 卡片在滑軌裡只佔一半寬,視窗卻仍然寬,於是選到最扁的比例、主視覺
            // 高度掉到 ~154px:扣掉 p-6 的 24 與讓給玻璃列的 pb-20 的 80,只剩
            // 50px,標題(行高 ~37)加 gap 就吃光了,description 一行都放不下。
            // 給一個地板值,讓比例再扁也不會壓掉文字。
            className="relative aspect-[5/2] w-full min-h-52 overflow-hidden md:aspect-[3/1]"
            style={{
              backgroundImage: `linear-gradient(135deg, ${tintA}, ${tintB})`,
            }}
          >
            <div className="flex h-full flex-col gap-1.5 p-6 pb-20 pr-28">
              <span className="text-balance text-[clamp(22px,3.2vw,32px)] font-bold leading-tight tracking-[-0.02em] text-ink/85">
                {entry.name}
              </span>
              {entry.description && (
                <span className="line-clamp-2 max-w-[560px] text-[13px] leading-relaxed text-ink/45">
                  {entry.description}
                </span>
              )}
            </div>
            {/* createElement 繞 static-components 誤報(同 ExtIcon 註解)。 */}
            {createElement(extGlyph(entry), {
              "aria-hidden": true,
              strokeWidth: 1,
              className: "absolute -bottom-8 -right-6 size-40 text-ink/[0.07]",
            })}
          </div>
        )}
        {/* 圖底固定 bar:glass。 */}
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 border-t border-ink/[0.05] bg-surface/75 px-4 py-2.5 backdrop-blur-md">
          <ExtIcon entry={entry} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-ink/90">
              {entry.name}
            </span>
            <span className="flex items-center gap-2 text-[11px] text-ink/45">
              v{entry.version} · {kindLabel(t, entry.kind)}
              {entry.installed && (
                <span className="inline-flex items-center gap-1 rounded-full bg-(--admin-accent)/10 px-2 py-0.5 font-medium text-(--admin-accent)">
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
                className="inline-flex h-9 items-center gap-1.5 rounded-[calc(8px*var(--admin-radius-scale,1))] px-4 text-[13px] font-medium"
              />
            ) : !entry.compatible ? (
              <div className="flex flex-col items-end gap-1">
                <button
                  type="button"
                  disabled
                  className="inline-flex h-9 items-center rounded-[calc(8px*var(--admin-radius-scale,1))] bg-ink/[0.06] px-4 text-[13px] font-medium text-ink/35"
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
                  className="inline-flex h-9 items-center rounded-[calc(8px*var(--admin-radius-scale,1))] bg-ink/[0.06] px-4 text-[13px] font-medium text-ink/35"
                >
                  {t("registryBrowser.install.install")}
                </button>
                <span className="text-[10px] text-red-600/70">
                  {t("registryBrowser.install.needsFeatures", {
                    features: missing.join(", "),
                  })}
                </span>
              </div>
            ) : blocked ? (
              <span className="text-[12px] text-ink/50">{blocked}</span>
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
      {review && (
        <div onClick={(e) => e.stopPropagation()}>
          <ScriptReviewDialog
            extensionId={entry.id}
            extensionName={entry.name}
            scripts={review.scripts}
            confirmLabel={t("scripts.approveInstall")}
            submitting={state === "installing"}
            error={error}
            onCancel={closeReview}
            onConfirm={() => void confirmReview()}
          />
        </div>
      )}
    </div>
  );
}

// Featured 滑軌。垂直堆疊時每張 hero 卡都佔滿寬度,兩張就把首屏吃光,下面的
// 搜尋與完整列表被推到摺線外 —— featured 反而擋住了「找東西」這件主要工作。
// 改成橫向 snap 滑軌:一次只佔一屏的一部分,下一張露出一角當作可捲動的可供性
// (所以卡片寬度刻意不是 100%),鍵盤與觸控都能操作,箭頭只是輔助。
function FeaturedShelf({
  header,
  children,
}: {
  header: React.ReactNode;
  children: React.ReactNode;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const sync = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    // 1px 容差:scrollWidth/clientWidth 在縮放與分數像素下不會剛好相等。
    const max = el.scrollWidth - el.clientWidth;
    setAtStart(el.scrollLeft <= 1);
    setAtEnd(el.scrollLeft >= max - 1);
  }, []);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    sync();
    // 卡片是非同步載入的圖,寬度會變 —— 只聽 scroll 會讓箭頭停在過期狀態。
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, [sync]);

  function page(direction: -1 | 1) {
    const el = trackRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * 0.9, behavior: "smooth" });
  }

  const arrow =
    "inline-flex size-7 items-center justify-center rounded-full border border-ink/10 bg-surface text-ink/55 transition-[color,background-color,opacity] hover:bg-ink/[0.04] hover:text-ink/80 disabled:pointer-events-none disabled:opacity-30";

  return (
    <>
      <div className="flex items-center gap-2">
        {header}
        {/* 兩端都到底(內容塞得下)時整組箭頭收起來,不留兩顆永遠灰掉的按鈕。 */}
        {!(atStart && atEnd) && (
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => page(-1)}
              disabled={atStart}
              className={arrow}
              aria-label="Previous"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => page(1)}
              disabled={atEnd}
              className={arrow}
              aria-label="Next"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        )}
      </div>
      <div
        ref={trackRef}
        onScroll={sync}
        // min-w-0:橫向捲動容器該有的自保,讓它的內容寬度不往祖先傳。
        // (真正讓整頁能左右捲的是外殼 SidebarInset 的 `lg:min-w-0`,已在該處
        //  改為無條件 min-w-0;這裡保留是為了不依賴外層的正確性。)
        // overflow-x:auto 會把 overflow-y 也變成 auto,所以卡片的圓角光暈與陰影
        // 一定會被裁掉。內距就是留給陰影的空間,四邊都要:
        //   pt-2.5 / pb-7  —— 陰影主要往下(hover 是 0 16px 48px -12px),下面給多一點
        //   px-3.5         —— 首尾兩張的側邊陰影
        // 水平方向用 -mx-3.5 把內距抵銷掉,卡片才會跟下面的搜尋框、列表切齊;
        // scroll-px-3.5 讓 snap 對齊到內距之內,而不是貼著容器邊。
        //
        // 垂直方向不能比照辦理:負的上邊距會讓這個框蓋住箭頭、負的下邊距會蓋住
        // 搜尋框,兩者都會擋掉點擊(實測過)。所以上方改用外層 gap-1 來收窄,
        // 下方就讓它多留一點呼吸空間。
        className="no-scrollbar -mx-3.5 flex min-w-0 snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-3.5 pt-2.5 pb-7 scroll-px-3.5"
      >
        {children}
      </div>
    </>
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
  blocked,
  nameOf,
  onClick,
  onInstalled,
}: {
  entry: RegistryEntry;
  /** 1.50.0:不能直接裝的理由(見 cardBlockLabel);有就不畫安裝鈕。 */
  blocked: string | null;
  /** 1.50.0:必要插件的顯示名稱(安裝失敗的訊息用)。 */
  nameOf: (id: string) => string;
  onClick: () => void;
  onInstalled: (id: string, source: string) => void;
}) {
  const t = useT();
  const {
    state,
    error,
    prompts,
    install,
    submitPrompts,
    closePrompts,
    review,
    confirmReview,
    closeReview,
  } = useInstallFlow(entry, onInstalled, nameOf);
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
      className={`group flex cursor-pointer flex-col gap-3 rounded-[calc(14px*var(--admin-radius-scale,1))] bg-surface p-4 ${CARD} transition-[box-shadow] duration-150 hover:shadow-[0_0_0_1px_rgba(0,0,0,0.1),0_4px_12px_-2px_rgba(0,0,0,0.08)]`}
    >
      {/* header */}
      <div className="flex items-start gap-3">
        <ExtIcon entry={entry} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[14px] font-semibold text-ink/85">
            {entry.name}
          </span>
          <span className="line-clamp-2 text-[12px] leading-relaxed text-ink/45">
            {entry.description ?? t("registryBrowser.noDescription")}
          </span>
        </div>
      </div>
      {/* meta + badges */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-ink/[0.04] px-2 py-0.5 text-[10px] font-medium text-ink/45">
          {kindLabel(t, entry.kind)}
        </span>
        {entry.category && (
          <span className="rounded-full bg-ink/[0.04] px-2 py-0.5 text-[10px] font-medium capitalize text-ink/45">
            {entry.category}
          </span>
        )}
        <DeploymentBadge entry={entry} />
        <span className="text-[10px] text-ink/35">v{entry.version}</span>
        {entry.author && (
          <span className="text-[10px] text-ink/35">· {entry.author}</span>
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
              className="inline-flex h-7 items-center gap-1 rounded-[calc(6px*var(--admin-radius-scale,1))] px-3 text-[11px] font-medium"
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
          ) : blocked ? (
            <span className="text-[11px] text-ink/50">{blocked}</span>
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
      {review && (
        <div onClick={(e) => e.stopPropagation()}>
          <ScriptReviewDialog
            extensionId={entry.id}
            extensionName={entry.name}
            scripts={review.scripts}
            confirmLabel={t("scripts.approveInstall")}
            submitting={state === "installing"}
            error={error}
            onCancel={closeReview}
            onConfirm={() => void confirmReview()}
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
  const [selected, setSelected] = useState<{ source: string; id: string } | null>(null);
  const setSelectedEntry = (entry: RegistryEntry | null) =>
    setSelected(entry ? { source: entry.source, id: entry.id } : null);

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
        // code entry 的 installed/installedVersion 由伺服器以 bundle 事實(編譯進來的
        // 版本)算好;1.50.0 起一併比對 identity,所以這裡不再用 installedCode 覆蓋。
        const json = (await res.json()) as IndexResponse;
        if (!cancelled) setData(json);
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
    // Featured = compatible、尚未安裝的前幾個。上限從 2 提到 6:滑軌只放兩張
    // 就沒有滑的意義,而卡片不再各佔一整屏之後,多放幾張也不會壓到下面的列表。
    return data.entries.filter((e) => e.compatible && !e.installed).slice(0, 6);
  }, [data]);

  // 1.50.0:站上已安裝的插件,判斷相依用(詳情頁與卡片)。
  const installedPlugins = useMemo(
    () => new Map((data?.installedPlugins ?? []).map((p) => [p.id, p])),
    [data],
  );
  const locale = useLocale();
  const pluginNamer = useCallback(
    (entry: RegistryEntry) => (id: string) =>
      requiredPluginName(entry, id, installedPlugins, data?.entries ?? [], locale),
    [installedPlugins, data, locale],
  );

  // 安裝/更新成功 → 就地更新 client 端的 registry data(installedVersion 對齊 registry
  // 版本,其他來源的同 id 項目變成衝突,已安裝清單補上它),列表卡、detail 頁、featured
  // 全部即時反映;不等重新 fetch /api/registry/index。
  // selectedEntry 只存身分(source + id),內容一律從 data 取,更新後自然是新的。
  const handleInstalled = useCallback((id: string, source: string) => {
    setData((prev) => (prev ? markInstalled(prev, id, source) : prev));
  }, []);

  if (loading) {
    return <LoadingState label={t("registryBrowser.loading")} />;
  }

  if (loadError) {
    return (
      <div className="rounded-[calc(14px*var(--admin-radius-scale,1))] border border-red-600/20 bg-red-50 p-6 text-center">
        <AlertCircle className="mx-auto size-6 text-red-600/60" />
        <p className="mt-2 text-[14px] font-medium text-red-700">{loadError}</p>
      </div>
    );
  }

  if (!data) return null;

  // Detail view
  const selectedEntry = selected
    ? data.entries.find((e) => e.source === selected.source && e.id === selected.id)
    : undefined;
  if (selectedEntry) {
    return (
      <ExtensionDetail
        // key:從一個插件的詳情前往另一個(必要插件)時,安裝流程的狀態全新。
        key={`${selectedEntry.source}:${selectedEntry.id}`}
        entry={selectedEntry}
        entries={data.entries}
        installed={installedPlugins}
        services={data.services ?? []}
        onBack={() => setSelectedEntry(null)}
        onOpen={setSelectedEntry}
        onInstalled={handleInstalled}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Errors */}
      {data.errors.length > 0 && (
        <div className="flex flex-col gap-1 rounded-[calc(10px*var(--admin-radius-scale,1))] border border-red-600/15 bg-red-50 px-4 py-3">
          {data.errors.map((e) => (
            <p key={e.source} className="text-[12px] text-red-700">
              {e.source}: {e.error}
            </p>
          ))}
        </div>
      )}

      {/* Featured */}
      {featured.length > 0 && (
        // 同上:這層也要 min-w-0,否則寬度會沿著祖先鏈一路傳到 <main>。
        // gap-1 而非 gap-3:滑軌自帶 pt-2.5 的陰影空間,標題列與卡片之間的
        // 視覺間距由兩者相加,gap 維持 gap-3 會顯得太鬆。
        <div className="flex min-w-0 flex-col gap-1">
          <FeaturedShelf
            header={
              <>
                <Sparkles className="size-4 text-(--admin-accent)" />
                <span className="text-[14px] font-semibold tracking-[-0.01em] text-ink/85">
                  {t("registryBrowser.featured")}
                </span>
              </>
            }
          >
            {featured.map((entry) => (
              // 刻意不是 w-full:下一張露出的一角就是「還有更多、可以捲」的訊號。
              <div
                key={`f-${entry.source}:${entry.id}`}
                className="w-[88%] shrink-0 snap-start sm:w-[72%] lg:w-[54%]"
              >
                <FeaturedCard
                  entry={entry}
                  blocked={cardBlockLabel(t, entry, installedPlugins)}
                  nameOf={pluginNamer(entry)}
                  onClick={() => setSelectedEntry(entry)}
                  onInstalled={handleInstalled}
                />
              </div>
            ))}
          </FeaturedShelf>
        </div>
      )}

      {/* Search + Category */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 rounded-[calc(10px*var(--admin-radius-scale,1))] border border-ink/10 bg-surface px-3 py-2 shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.04))]">
          <Search className="size-4 shrink-0 text-ink/35" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("registryBrowser.searchPlaceholder")}
            className="w-full bg-transparent text-[14px] text-ink/85 outline-none placeholder:text-ink/30"
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
      <p className="text-[13px] text-ink/40">
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
        <div className="rounded-[calc(14px*var(--admin-radius-scale,1))] border border-dashed border-ink/20 p-10 text-center">
          <p className="text-[14px] font-medium text-ink/45">
            {t("registryBrowser.empty.title")}
          </p>
          <p className="mt-1 text-[12px] text-ink/30">
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
              blocked={cardBlockLabel(t, entry, installedPlugins)}
              nameOf={pluginNamer(entry)}
              onClick={() => setSelectedEntry(entry)}
              onInstalled={handleInstalled}
            />
          ))}
        </motion.div>
      )}
    </div>
  );
}

// 公開 registry(CLI 的預設來源):從這裡來的不必加 --source。
const PUBLIC_REGISTRY = "https://raw.githubusercontent.com/sz-ws/registry/main";

// 程式碼插件的安裝指令,給自架這套 CMS 的開發者。老闆看不到也不需要,所以預設收合,
// 放在詳情頁最下面;展開後一行指令可以直接複製。
function DevInstall({ entry, update }: { entry: RegistryEntry; update: boolean }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const external = entry.source.replace(/\/+$/, "") !== PUBLIC_REGISTRY;
  const command = [
    `npx @sz.ws/cms add ${entry.id}`,
    external ? `--source ${entry.source}` : null,
    update ? "--force" : null,
  ]
    .filter(Boolean)
    .join(" ");

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 沒有剪貼簿權限就算了,指令還在畫面上可以手動選。
    }
  }

  return (
    <details
      className={`group rounded-[calc(14px*var(--admin-radius-scale,1))] bg-surface px-6 py-4 ${CARD}`}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between text-[13px] font-medium text-ink/55 [&::-webkit-details-marker]:hidden">
        {t("registryBrowser.dev.title")}
        <ChevronRight className="size-4 text-ink/35 transition-transform group-open:rotate-90" />
      </summary>
      <div className="mt-3 flex flex-col gap-2.5">
        <p className="text-[12.5px] leading-relaxed text-ink/55">{t("registryBrowser.dev.intro")}</p>
        <div className="flex items-center gap-2 rounded-[calc(8px*var(--admin-radius-scale,1))] bg-ink/[0.04] py-1.5 pl-3 pr-1.5">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12.5px] text-ink/80">
            {command}
          </code>
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-[calc(6px*var(--admin-radius-scale,1))] px-2 text-[12px] font-medium text-ink/55 transition-colors hover:bg-ink/[0.06] hover:text-ink/85"
          >
            {copied ? <Check className="size-3.5" /> : null}
            {copied ? t("registryBrowser.dev.copied") : t("registryBrowser.dev.copy")}
          </button>
        </div>
        {external && (
          <p className="text-[12px] leading-relaxed text-ink/45">{t("registryBrowser.dev.token")}</p>
        )}
      </div>
    </details>
  );
}

function ExtensionDetail({
  entry,
  entries,
  installed,
  services,
  onBack,
  onOpen,
  onInstalled,
}: {
  entry: RegistryEntry;
  /** 商店裡全部的項目(找必要插件、列出需要它的插件)。 */
  entries: readonly RegistryEntry[];
  installed: ReadonlyMap<string, InstalledPluginRef>;
  services: string[];
  onBack: () => void;
  /** 1.50.0:前往另一個插件的詳情(必要插件、需要它的插件)。 */
  onOpen: (entry: RegistryEntry) => void;
  onInstalled: (id: string, source: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const nameOf = (id: string) => requiredPluginName(entry, id, installed, entries, locale);
  const {
    state,
    error,
    prompts,
    install,
    submitPrompts,
    closePrompts,
    review,
    confirmReview,
    closeReview,
  } = useInstallFlow(entry, onInstalled, nameOf);
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

  // 程式碼插件管理員自己裝不了:按鈕位置放狀態,底下一句話說誰來做。
  const codeState = entry.kind === "code" ? codeEntryState(entry) : null;
  const codeNote =
    codeState === "none"
      ? t("registryBrowser.detail.codeNote")
      : codeState === "update"
        ? t("registryBrowser.detail.codeUpdateNote")
        : null;

  // 需要項目只列管理員該知道的:不支援的功能、以及服務需求(附原因)。
  // 支援的 core 功能代號(contents、admin-pages…)對管理員沒有意義,不列。
  const requires = entry.requires ?? [];
  const requiredPlugins = entry.requiresExtensions ?? [];
  const showRequirements = missing.length > 0 || requires.length > 0 || requiredPlugins.length > 0;
  // 1.50.0:宣告式插件現在不能裝的理由(同名衝突、別的來源、缺必要插件),右欄畫說明取代安裝鈕。
  const gate =
    entry.kind === "declarative" && entry.compatible && missing.length === 0 && unmetServices.length === 0 ? (
      <InstallGate
        entry={entry}
        installed={installed}
        entries={entries}
        onOpen={onOpen}
        onReplaceSource={(installedSource) => void install(installedSource)}
        busy={state === "installing"}
      />
    ) : null;
  const gated =
    entry.kind === "declarative" &&
    (entry.conflict != null || entryUnmetPlugins(entry, installed).length > 0);

  const links = [
    { label: t("registryBrowser.detail.link.homepage"), url: entry.homepage },
    { label: t("registryBrowser.detail.link.repository"), url: entry.repository },
    { label: t("registryBrowser.detail.link.support"), url: entry.supportUrl },
  ].filter((l): l is { label: string; url: string } => !!l.url);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 280, damping: 26 }}
      className="flex flex-col gap-6"
    >
      <button
        type="button"
        onClick={onBack}
        className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-ink/45 transition-colors hover:text-ink/85"
      >
        ← {t("registryBrowser.detail.back")}
      </button>

      <div className="flex items-center gap-4">
        <ExtIcon entry={entry} size="large" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="text-[24px] font-bold tracking-[-0.02em] text-ink/90">
            {entry.name}
          </h1>
          <span className="text-[13px] text-ink/45">
            {kindLabel(t, entry.kind)}
          </span>
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

      {review && (
        <ScriptReviewDialog
          extensionId={entry.id}
          extensionName={entry.name}
          scripts={review.scripts}
          confirmLabel={t("scripts.approveInstall")}
          submitting={state === "installing"}
          error={error}
          onCancel={closeReview}
          onConfirm={() => void confirmReview()}
        />
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-[calc(8px*var(--admin-radius-scale,1))] bg-red-50 px-3 py-2 text-[13px] text-red-700">
          <AlertCircle className="size-4" />
          {error}
        </div>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="flex min-w-0 flex-col gap-6">
          {bannerUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={bannerUrl}
              alt=""
              className="h-40 w-full rounded-[calc(14px*var(--admin-radius-scale,1))] object-cover sm:h-52"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          )}

          <section className={`rounded-[calc(14px*var(--admin-radius-scale,1))] bg-surface px-6 py-5 ${CARD}`}>
            <h2 className="mb-2 text-[15px] font-semibold tracking-[-0.01em] text-ink/85">
              {t("registryBrowser.detail.about")}
            </h2>
            <p className="text-[14px] leading-relaxed text-ink/65">
              {entry.description || t("registryBrowser.noDescription")}
            </p>
          </section>

          {showRequirements && (
            <section className={`rounded-[calc(14px*var(--admin-radius-scale,1))] bg-surface px-6 py-5 ${CARD}`}>
              <h2 className="mb-3 text-[15px] font-semibold tracking-[-0.01em] text-ink/85">
                {t("registryBrowser.detail.requires")}
              </h2>
              <ul className="flex flex-col gap-3">
                <RequiredPluginItems entry={entry} installed={installed} entries={entries} onOpen={onOpen} />
                {missing.map((cap) => (
                  <li key={cap} className="flex flex-col gap-0.5">
                    <span className="text-[13px] font-medium text-red-700">
                      {cap} {t("registryBrowser.detail.notSupportedBadge")}
                    </span>
                    <span className="text-[12.5px] text-ink/50">
                      {t("registryBrowser.detail.notSupportedTitle")}
                    </span>
                  </li>
                ))}
                {requires.map((req) => {
                  const met = services.includes(req.capability);
                  const tone = met
                    ? "text-[rgb(18,124,88)]"
                    : req.optional
                      ? "text-amber-700"
                      : "text-red-700";
                  const badge = met
                    ? t("registryBrowser.detail.serviceProvided")
                    : req.optional
                      ? t("registryBrowser.detail.serviceOptional")
                      : t("registryBrowser.detail.serviceMissing");
                  return (
                    <li key={`svc-${req.capability}`} className="flex flex-col gap-0.5">
                      <span className="text-[13px] text-ink/80">
                        {req.capability}
                        <span className={cn("ml-2 text-[12px] font-medium", tone)}>{badge}</span>
                      </span>
                      {req.reason && (
                        <span className="text-[12.5px] leading-relaxed text-ink/50">{req.reason}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {screenshots.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink/85">
                {t("registryBrowser.detail.screenshots")}
              </h2>
              <div className="flex gap-3 overflow-x-auto pb-2">
                {screenshots.map((url, i) => (
                  // 照原比例、固定高度,不裁切:介紹圖常是示範畫面(例如左下角浮層),裁掉就看不到重點。
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={url}
                    alt={`Screenshot ${i + 1}`}
                    loading="lazy"
                    className="h-56 w-auto max-w-full shrink-0 rounded-[calc(12px*var(--admin-radius-scale,1))] bg-surface shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_2px_8px_-2px_rgba(0,0,0,0.08))] sm:h-72"
                  />
                ))}
              </div>
            </section>
          )}

          <UsedBySection
            entry={entry}
            entries={entries}
            onOpen={onOpen}
            className={`rounded-[calc(14px*var(--admin-radius-scale,1))] bg-surface px-6 py-5 ${CARD}`}
          />

          {entry.kind === "code" && codeState !== "installed" && (
            <DevInstall entry={entry} update={codeState === "update"} />
          )}
        </div>

        <aside
          className={`order-first flex flex-col gap-4 rounded-[calc(14px*var(--admin-radius-scale,1))] bg-surface p-5 lg:sticky lg:top-6 lg:order-none ${CARD}`}
        >
          <div className="flex flex-col gap-2">
            {entry.kind === "code" ? (
              <CodeStateChip
                entry={entry}
                t={t}
                className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-[calc(8px*var(--admin-radius-scale,1))] px-4 text-[13px] font-medium"
              />
            ) : !entry.compatible ? (
              <span className="text-[12.5px] text-red-600/80">
                {t("registryBrowser.install.requiresCore", { core: entry.coreApi })}
              </span>
            ) : missing.length > 0 ? (
              <span className="text-[12.5px] text-red-600/80">
                {t("registryBrowser.install.needsFeatures", { features: missing.join(", ") })}
              </span>
            ) : unmetServices.length > 0 ? (
              <span className="text-[12.5px] text-red-600/80">
                {t("registryBrowser.install.needsServices", { services: unmetServices.join(", ") })}
              </span>
            ) : gated ? (
              gate
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
            {codeNote && (
              <p className="text-[12.5px] leading-relaxed text-ink/50">{codeNote}</p>
            )}
          </div>

          <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 border-t border-ink/[0.06] pt-4 text-[13px]">
            <dt className="text-ink/45">{t("registryBrowser.detail.version")}</dt>
            <dd className="tabular-nums text-ink/80">
              {isUpdate ? `v${entry.installedVersion} → v${entry.version}` : `v${entry.version}`}
            </dd>
            {entry.author && (
              <>
                <dt className="text-ink/45">{t("registryBrowser.detail.author")}</dt>
                <dd className="truncate text-ink/80">{entry.author}</dd>
              </>
            )}
            {entry.category && (
              <>
                <dt className="text-ink/45">{t("registryBrowser.detail.category")}</dt>
                <dd className="text-ink/80">{categoryLabel(t, entry.category)}</dd>
              </>
            )}
            {entry.license && (
              <>
                <dt className="text-ink/45">{t("registryBrowser.detail.license")}</dt>
                <dd className="text-ink/80">{entry.license}</dd>
              </>
            )}
            {!entry.compatible && (
              <>
                <dt className="text-ink/45">{t("registryBrowser.detail.compatibility")}</dt>
                <dd className="text-red-600/80">
                  {t("registryBrowser.detail.requiresCoreApi", { core: entry.coreApi })}
                </dd>
              </>
            )}
            {links.map((link) => (
              <Fragment key={link.url}>
                <dt className="text-ink/45">{link.label}</dt>
                <dd className="min-w-0">
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block truncate text-(--admin-accent) hover:underline"
                  >
                    {link.url.replace(/^https?:\/\//, "")}
                  </a>
                </dd>
              </Fragment>
            ))}
          </dl>
        </aside>
      </div>
    </motion.div>
  );
}
