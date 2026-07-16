import { gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { contents } from "@/lib/schema";
import { listFiles } from "@/lib/storage";
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
export async function getStorageStats(): Promise<{
  fileCount: number;
  totalBytes: number;
  truncated: boolean;
}> {
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

export { formatBytes };
