"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Clock, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useImeGuard } from "@/lib/ime";
import { DotmSquare5 } from "@/components/ui/dotm-square-5";
import { StatusDot } from "@/components/admin/dashboard/StatusDot";
import { useT } from "@/lib/i18n/I18nProvider";

// ⌘K 全站內容搜尋(FTS5 後端:GET /api/search)。Paper & Ink command palette:
// 大圓角白面板、上緣獨立搜尋列、空 query 顯示最近搜尋(localStorage)、底部 kbd
// 提示列。鍵盤優先:⌘K/Ctrl+K 開、Esc 關、↑↓ 選、Enter 前往 entry 編輯頁。
// 常駐 mount(AdminShell),open 由 AnimatePresence 驅動進退場。

interface SearchHit {
  id: string;
  typeKey: string;
  typeLabel: string;
  title: string;
  snippet: string;
  status: "draft" | "published";
  editHref: string | null;
}

const RECENT_KEY = "cms.search.recent";
const RECENT_MAX = 8;
const DEBOUNCE_MS = 180;

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((s): s is string => typeof s === "string").slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

function pushRecent(q: string): string[] {
  const next = [q, ...readRecent().filter((s) => s !== q)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // storage 滿/私隱模式:最近搜尋是純便利功能,靜默放棄。
  }
  return next;
}

export function SearchPalette() {
  const t = useT();
  const ime = useImeGuard();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 全域快捷鍵:⌘K / Ctrl+K 切換、Esc 關閉。localStorage 在 handler 內讀(事件
  // 處理器可以 impure;render 內不碰)。
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((was) => {
          if (!was) {
            setQ("");
            setHits([]);
            setSelected(0);
            setRecent(readRecent());
          }
          return !was;
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // debounce 查詢;AbortController 淘汰過期回應(快打字時舊回應不可蓋新結果)。
  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    const controller = new AbortController();
    // 短 query 的清空也走 timer callback(effect body 同步 setState 會被
    // react-hooks/set-state-in-effect 擋;async callback 允許)。
    const timer = setTimeout(() => {
      if (query.length < 2) {
        setHits([]);
        return;
      }
      fetch(`/api/search?q=${encodeURIComponent(query)}&limit=12`, {
        signal: controller.signal,
      })
        .then((r) =>
          r.ok
            ? (r.json() as Promise<{ results?: SearchHit[] }>)
            : { results: [] as SearchHit[] },
        )
        .then((body) => {
          setHits(body.results ?? []);
          setSelected(0);
          setSearching(false);
        })
        .catch(() => {
          // abort / 網路錯誤:保留現有結果,不閃爍。
          setSearching(false);
        });
    }, q.trim().length < 2 ? 0 : DEBOUNCE_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, q]);

  function close() {
    setOpen(false);
  }

  function go(hit: SearchHit) {
    if (!hit.editHref) return;
    setRecent(pushRecent(q.trim()));
    close();
    router.push(hit.editHref);
  }

  const showingRecent = q.trim().length < 2;
  const rows = showingRecent ? recent : hits;

  function onInputKey(e: React.KeyboardEvent) {
    // **第一行。** 打注音時按 Enter 是在確定候選字,↑↓ 是在翻候選清單 —— 這一頁的
    // Enter 會直接換頁,搶走它等於把使用者打到一半的字丟掉(見 @/lib/ime)。
    if (ime.isComposingKey(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (rows.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => {
        const d = e.key === "ArrowDown" ? 1 : -1;
        return (i + d + rows.length) % rows.length;
      });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (showingRecent) {
        const picked = recent[selected];
        if (picked) {
          setQ(picked);
          setSearching(true);
        }
      } else {
        const hit = hits[selected];
        if (hit) go(hit);
      }
    }
  }

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="search-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[2px]"
          onClick={close}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={t("search.placeholder")}
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            transition={{ type: "spring", duration: 0.3, bounce: 0 }}
            onClick={(e) => e.stopPropagation()}
            // 同心圓:input rounded-[10px] + 外距 14px(p-3.5)→ 面板 24px。
            // (方向:收斂 input 的圓角,而不是把容器撐得更圓 —— 容器過圓會逼列
            // hover 變 pill、footer 貼弧線,整組跟著變形。)
            className="mx-auto mt-[12vh] flex max-h-[64vh] w-[min(40rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-[24px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_24px_64px_-16px_rgba(30,20,50,0.25)]"
          >
            {/* 搜尋列:input 撐滿整寬,loader 與 close 都 inline 在最右端。 */}
            <div className="p-3.5 pb-2">
              <div className="flex h-11 items-center gap-2.5 rounded-[10px] bg-black/[0.04] pr-1.5 pl-3.5 transition-shadow focus-within:shadow-[0_0_0_1.5px_rgba(0,0,0,0.14)]">
                <Search className="size-4 shrink-0 text-black/35" />
                <input
                  ref={inputRef}
                  autoFocus
                  value={q}
                  onChange={(e) => {
                    const next = e.target.value;
                    setQ(next);
                    // 打字即亮:loader 涵蓋 debounce + fetch 全程(本機 API 太快,
                    // 只在 in-flight 顯示肉眼看不到)。
                    setSearching(next.trim().length >= 2);
                  }}
                  onKeyDown={onInputKey}
                  onCompositionStart={ime.onCompositionStart}
                  onCompositionEnd={ime.onCompositionEnd}
                  placeholder={t("search.placeholder")}
                  className="h-full flex-1 bg-transparent text-[14px] text-black/85 outline-none placeholder:text-black/30"
                />
                {/* 搜尋中:dot-matrix loader(reduced-motion 由元件自己處理)。 */}
                {searching && (
                  <DotmSquare5
                    size={18}
                    dotSize={2.5}
                    color="rgba(0,0,0,0.45)"
                    ariaLabel=""
                    className="shrink-0"
                  />
                )}
                <button
                  type="button"
                  onClick={close}
                  aria-label={t("search.kbdClose")}
                  className="flex size-8 shrink-0 items-center justify-center rounded-[7px] text-black/35 transition-[background-color,color,transform] hover:bg-black/[0.06] hover:text-black/70 active:scale-[0.96]"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>

            {/* 主體:最近搜尋 or 結果列表(獨立捲動)。列 hover 同 input 的 10px 家族。 */}
            <div className="flex-1 overflow-y-auto px-3.5 pb-2.5">
              {showingRecent ? (
                recent.length > 0 ? (
                  <>
                    <div className="flex items-center justify-between px-4 pt-2 pb-1.5">
                      <p className="text-[11px] font-semibold tracking-[0.06em] text-black/35 uppercase">
                        {t("search.recent")}
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          try {
                            localStorage.removeItem(RECENT_KEY);
                          } catch {
                            // 同 pushRecent:便利功能,靜默放棄。
                          }
                          setRecent([]);
                        }}
                        className="text-[11.5px] text-black/35 transition-colors hover:text-black/60"
                      >
                        {t("search.clear")}
                      </button>
                    </div>
                    {recent.map((r, i) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => {
                          setQ(r);
                          setSearching(true);
                        }}
                        onMouseMove={() => setSelected(i)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-[10px] px-3.5 py-2.5 text-left text-[13.5px] text-black/70 transition-colors",
                          selected === i && "bg-black/[0.04]",
                        )}
                      >
                        <Clock className="size-3.5 shrink-0 text-black/30" />
                        <span className="truncate">{r}</span>
                      </button>
                    ))}
                  </>
                ) : (
                  <p className="px-3.5 py-8 text-center text-[13px] text-black/35">
                    {t("search.hint")}
                  </p>
                )
              ) : hits.length > 0 ? (
                hits.map((hit, i) => (
                  <button
                    key={`${hit.typeKey}:${hit.id}`}
                    type="button"
                    disabled={!hit.editHref}
                    onClick={() => go(hit)}
                    onMouseMove={() => setSelected(i)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-[10px] px-3.5 py-2.5 text-left transition-colors",
                      selected === i && "bg-black/[0.04]",
                      !hit.editHref && "cursor-default opacity-60",
                    )}
                  >
                    <StatusDot
                      tone={hit.status === "published" ? "good" : "draft"}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-px">
                      <span className="truncate text-[13.5px] font-medium text-black/85">
                        {hit.title || hit.snippet}
                      </span>
                      {hit.title && hit.snippet && hit.snippet !== hit.title && (
                        <span className="truncate text-[12px] text-black/40">
                          {hit.snippet}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-[11.5px] text-black/35">
                      {hit.typeLabel}
                    </span>
                  </button>
                ))
              ) : (
                <p className="px-3.5 py-8 text-center text-[13px] text-black/35">
                  {t("search.noResults", { q: q.trim() })}
                </p>
              )}
            </div>

            {/* kbd 提示 footer(參考 vibe):hairline 上緣。 */}
            <div className="flex items-center justify-between border-t border-black/[0.06] px-5 py-3 text-[11.5px] text-black/40">
              <span className="flex items-center gap-3">
                <span className="flex items-center gap-1.5">
                  <Kbd>⌘K</Kbd>
                  {t("search.kbdOpen")}
                </span>
                <span className="flex items-center gap-1.5">
                  <Kbd>esc</Kbd>
                  {t("search.kbdClose")}
                </span>
              </span>
              <span className="flex items-center gap-3">
                <span className="flex items-center gap-1.5">
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd>
                  {t("search.kbdNavigate")}
                </span>
                <span className="flex items-center gap-1.5">
                  <Kbd>↵</Kbd>
                  {t("search.kbdGo")}
                </span>
              </span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="flex h-5 min-w-5 items-center justify-center rounded-[5px] bg-black/[0.05] px-1.5 font-sans text-[10.5px] font-medium text-black/50 shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)]">
      {children}
    </kbd>
  );
}
