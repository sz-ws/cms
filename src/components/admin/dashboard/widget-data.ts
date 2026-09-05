import { gte } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { db } from "@/lib/db";
import { getDB } from "@/lib/cf";
import { contents } from "@/lib/schema";
import { listFiles } from "@/lib/storage";
import { storageIndexTag } from "@/ext/dx/cache-tags";
import type { TrendWidgetData } from "./widgets";

const DAY_MS = 86_400_000;
const TREND_DAYS = 14;
const STORAGE_PAGE_CAP = 5; // 5 頁 × 100 = 上限 500 檔案(dashboard tile,不求絕對精確)。

/**
 * 過去 14 天每日建立筆數(UTC 日界,跨時區站台會跟使用者當地日期差幾小時 —
 * dashboard tile 的精度足夠,不做 per-user timezone 換算)。單一 bounded 查詢
 * (WHERE createdAt >= cutoff)取回窗內全部 createdAt,JS 端 bucket——比對每天
 * 發一次 COUNT query 便宜,且避開 D1 SQL 日期函式的方言差異。
 */
export async function getWeeklyActivity(now: number): Promise<TrendWidgetData> {
  const windowStart = now - TREND_DAYS * DAY_MS;
  const prevWindowStart = windowStart - TREND_DAYS * DAY_MS;

  const rows = await db()
    .select({ createdAt: contents.createdAt })
    .from(contents)
    .where(gte(contents.createdAt, prevWindowStart));

  const series = Array.from({ length: TREND_DAYS }, () => 0);
  let currentTotal = 0;
  let previousTotal = 0;
  for (const r of rows) {
    if (r.createdAt >= windowStart) {
      const dayIndex = Math.min(
        TREND_DAYS - 1,
        Math.floor((r.createdAt - windowStart) / DAY_MS),
      );
      series[dayIndex]++;
      currentTotal++;
    } else {
      previousTotal++;
    }
  }

  const delta = currentTotal - previousTotal;
  const direction: "up" | "down" | "flat" =
    delta > 0 ? "up" : delta < 0 ? "down" : "flat";

  return {
    label: "Content activity",
    value: currentTotal,
    delta: {
      value: Math.abs(delta),
      direction,
      caption: "vs prior 14d",
    },
    series,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * Media Library 用量。bounded 分頁(STORAGE_PAGE_CAP)—— dashboard tile 用途,
 * 不追求對帳精度;`truncated` 標示是否還有更多檔案未計入(caller 可據此在
 * valueLabel 加 "+" 後綴)。
 */
export interface StorageStats {
  fileCount: number;
  totalBytes: number;
  truncated: boolean;
}

/** cache miss 時才真的掃 R2；最多 5 個 ListObjects(Class A)。 */
export async function scanStorageStats(): Promise<StorageStats> {
  let fileCount = 0;
  let totalBytes = 0;
  let cursor: string | undefined;
  let truncated = false;

  for (let page = 0; page < STORAGE_PAGE_CAP; page++) {
    const { files, cursor: next } = await listFiles("", cursor);
    fileCount += files.length;
    totalBytes += files.reduce((sum, f) => sum + f.size, 0);
    if (!next) {
      cursor = undefined;
      break;
    }
    cursor = next;
    if (page === STORAGE_PAGE_CAP - 1) truncated = true;
  }

  return { fileCount, totalBytes, truncated };
}

/**
 * R2 inventory snapshot。upload/delete 會 revalidate storage:index；一小時 TTL
 * 只是人工繞過 storage abstraction 時的保底。cache plumbing 失敗就直接掃描，
 * dashboard 不因快取層故障而消失。
 */
export async function getStorageStats(): Promise<StorageStats> {
  try {
    const run = unstable_cache(scanStorageStats, ["dashboard-storage-stats-v1"], {
      tags: [storageIndexTag()],
      revalidate: 3600,
    });
    return await run();
  } catch (error) {
    console.error(
      "[dashboard:cache] storage snapshot failed; falling back to R2 scan",
      error,
    );
    return scanStorageStats();
  }
}

export { formatBytes };

/** D1 方案配額(bytes)。超過就寫不進去 —— 這個數字是 hard limit,不是參考值。 */
export const D1_QUOTA_BYTES = {
  free: 500 * 1024 * 1024, // 500 MB
  paid: 10 * 1024 * 1024 * 1024, // 10 GB
} as const;

export type D1Plan = keyof typeof D1_QUOTA_BYTES;

/**
 * D1 資料庫目前大小。來源:任何 D1 查詢的 `meta.size_after`(Cloudflare 回報的
 * DB 實際大小,本機 miniflare 也支援)—— 這裡用一條零成本的 SELECT 1 換 meta。
 * 走 raw binding 而非 drizzle:drizzle 的回傳型別不透出 D1 meta。
 * 拿不到(binding 缺席、build 期)→ null,caller 藏卡片,不炸 dashboard。
 */
export async function getDatabaseStats(): Promise<{ bytes: number } | null> {
  try {
    const res = await getDB().prepare("SELECT 1").run();
    const bytes = res.meta.size_after;
    return typeof bytes === "number" && bytes > 0 ? { bytes } : null;
  } catch {
    return null;
  }
}
