"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";

// 側欄上「這一頁有事在等」的點(1.77.0)。哪幾頁有事由插件從插槽 AdminAttention 報(ext/admin-attention.ts),
// 這裡負責問(GET /api/admin/attention)與畫。
//
// 什麼時候問:側欄掛上時、換頁、分頁回到前景、有人說「剛處理完」(refreshAdminAttention)、平常每 120 秒
// (分頁在背景時不問)。5 秒內問過就等滿 5 秒再問 —— 連點幾頁不會變成連打幾次;「剛處理完」不受這個限制,
// 因為那正是點該消失的時候。只認最後出發的那一次;問不到就留著原本的,畫面上不說什麼。

/** refreshAdminAttention 送出的 window 事件。 */
export const ADMIN_ATTENTION_EVENT = "admin:attention";

const ENDPOINT = "/api/admin/attention";
/** 平常多久問一次。 */
const POLL_MS = 120_000;
/** 兩次之間至少隔多久(「剛處理完」例外)。 */
const MIN_GAP_MS = 5_000;

/** 後台路徑 → 幾件事在等;沒有事的頁不在裡面。 */
export type AttentionCounts = Readonly<Record<string, number>>;

const NO_COUNTS: AttentionCounts = {};

/**
 * 剛處理完一件事(核對了一筆、審了一件)的頁面呼叫:側欄馬上重問,點跟著更新。
 * 沒有側欄在聽、或在伺服器上執行,都沒有作用。
 */
export function refreshAdminAttention(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(ADMIN_ATTENTION_EVENT));
}

/** 這一頁有幾件事在等(沒有就是 0)。 */
export function attentionAt(counts: AttentionCounts, href: string): number {
  return Object.prototype.hasOwnProperty.call(counts, href) ? counts[href] : 0;
}

/** 回應裡的 counts → 只留 1 以上的有限數字;形狀不對回 null。 */
function parseCounts(body: unknown): AttentionCounts | null {
  if (typeof body !== "object" || body === null) return null;
  const { counts } = body as { counts?: unknown };
  if (typeof counts !== "object" || counts === null || Array.isArray(counts)) return null;
  return Object.fromEntries(
    Object.entries(counts).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 1,
    ),
  );
}

/** 回應裡的 unknown(這次問不到的頁);沒有或形狀不對就是空的。 */
function parseUnknown(body: unknown): string[] {
  const { unknown } = body as { unknown?: unknown };
  return Array.isArray(unknown) ? unknown.filter((href): href is string => typeof href === "string") : [];
}

interface Answer {
  counts: AttentionCounts;
  unknown: string[];
}

async function loadCounts(): Promise<Answer> {
  const response = await fetch(ENDPOINT, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body: unknown = await response.json();
  const counts = parseCounts(body);
  if (!counts) throw new Error("unexpected response");
  return { counts, unknown: parseUnknown(body) };
}

/**
 * 新的答案配上原本的:伺服器說這次問不到的頁(unknown)留著原本的件數,不會因為一次查詢失敗就把點拿掉;
 * 其他的頁照答案(不在 counts 裡 = 沒有事)。
 */
function merge(previous: AttentionCounts, answer: Answer): AttentionCounts {
  const kept = answer.unknown
    .map((href): [string, number] => [href, Math.max(attentionAt(previous, href), attentionAt(answer.counts, href))])
    .filter(([, count]) => count > 0);
  return kept.length ? { ...answer.counts, ...Object.fromEntries(kept) } : answer.counts;
}

export interface AttentionWatch {
  /** 該問了(掛上、換頁):5 秒內問過就等滿 5 秒再問。 */
  check: () => void;
  /** 不再問、不再聽;還在路上的答案也不交出去。 */
  stop: () => void;
}

/**
 * 問的節奏,不含 React(useAdminAttention 用它;測試直接打這裡)。只有一個計時器:永遠指著「下一次該問
 * 的時間」—— 剛問完是 120 秒後,5 秒內又被催就是滿 5 秒的那一刻。時間到了分頁卻在背景:不問,等它回到前景。
 */
export function watchAdminAttention(onCounts: (counts: AttentionCounts) => void): AttentionWatch {
  let stopped = false;
  let latest = 0;
  let lastAsked = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 連續問不到只記第一筆:伺服器掛著的時候,不要每兩分鐘在 console 多一行。
  let failing = false;
  // 上一次交出去的件數:伺服器說某一頁這次問不到時,那一頁照這裡的。
  let shown: AttentionCounts = NO_COUNTS;

  const visible = () => document.visibilityState === "visible";

  function ask(): void {
    clearTimeout(timer);
    timer = setTimeout(due, POLL_MS);
    lastAsked = Date.now();
    const ticket = ++latest;
    loadCounts().then(
      (answer) => {
        if (stopped || ticket !== latest) return;
        failing = false;
        shown = merge(shown, answer);
        onCounts(shown);
      },
      (error: unknown) => {
        if (stopped || ticket !== latest) return;
        if (!failing) console.error("[admin-attention] could not ask which pages have something waiting", error);
        failing = true;
      },
    );
  }

  function due(): void {
    timer = undefined;
    if (visible()) ask();
  }

  function check(): void {
    if (stopped) return;
    const wait = lastAsked + MIN_GAP_MS - Date.now();
    if (wait <= 0) {
      ask();
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(due, wait);
  }

  const onVisibility = () => {
    if (visible()) check();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener(ADMIN_ATTENTION_EVENT, ask);

  return {
    check,
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(ADMIN_ATTENTION_EVENT, ask);
    },
  };
}

function sameCounts(a: AttentionCounts, b: AttentionCounts): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === attentionAt(b, key));
}

/**
 * 每一頁現在有幾件事在等。routeKey 一變(換頁)就再問一次。件數沒變時回同一個物件,側欄不會白畫一次。
 * enabled 是 false 時不問(一般會員的後台只有帳戶頁,伺服器對他一律回空的,不必每兩分鐘問一次)。
 */
export function useAdminAttention(routeKey: string, enabled = true): AttentionCounts {
  const [counts, setCounts] = useState<AttentionCounts>(NO_COUNTS);
  const watch = useRef<AttentionWatch | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const started = watchAdminAttention((next) => setCounts((current) => (sameCounts(current, next) ? current : next)));
    watch.current = started;
    return () => {
      watch.current = null;
      started.stop();
    };
  }, [enabled]);

  // 掛上時問第一次(上面那個 effect 先跑,watch 已經在了),之後每換一頁再問。
  useEffect(() => {
    watch.current?.check();
  }, [routeKey, enabled]);

  return counts;
}

interface AttentionDotProps {
  /** 幾件事在等;0 不畫。 */
  count: number;
  /** 擺在哪裡由用的地方決定(列的尾端、圖示的右上角)。 */
  className?: string;
  /** 件數已經由外層交代(收成圖示的側欄寫在 title 裡)時,不再放一份給螢幕報讀的文字。 */
  silent?: boolean;
}

/**
 * 那個點。靜態的:不閃、不跳、不發光。只有點,沒有數字 —— 件數寫在給螢幕報讀的文字裡。
 * 顏色同設定頁左邊清單「要注意」的記號(SettingsNav 的 amber-600),在紙色與白色上都看得清楚。
 */
export function AttentionDot({ count, className, silent = false }: AttentionDotProps) {
  const t = useT();
  if (count <= 0) return null;
  return (
    <>
      <span
        aria-hidden
        data-slot="admin-attention"
        className={cn("size-1.5 shrink-0 rounded-full bg-amber-600", className)}
      />
      {!silent && <span className="sr-only"> {t("sidebar.attention", { count })}</span>}
    </>
  );
}
