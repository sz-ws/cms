import { desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "./db";
import { registryNotices, registryNoticeSeen } from "./schema";
import {
  fetchSourceNotices,
  getRegistrySources,
  type RegistrySourceConfig,
} from "./registry-client";
import {
  isStoredNotice,
  pickNotice,
  seenKey,
  type PickedNotice,
  type RegistryNotice,
} from "./registry-notices";

// 上新通知的快取與「看過」紀錄(migrations/0023)。解析與挑選是純函式,在 ./registry-notices.ts。
//
// 抓取:不做 CoreJob。只有管理員打開後台(GET /api/registry/notice)、而且某個打開通知的
// 來源的快取超過 12 小時,才在 waitUntil 裡讀一次那個來源的 registry.json;商店讀索引時也
// 順便更新(rememberNotices)。沒有管理員進後台,就沒有任何因通知而起的對外連線。

export const NOTICE_REFRESH_MS = 12 * 60 * 60 * 1000;
const NOTICE_ID_RE = /^[a-z0-9-]{1,64}$/;

/** 打開了上新通知的來源(預設都是關的)。 */
export async function noticeSources(): Promise<RegistrySourceConfig[]> {
  return (await getRegistrySources()).filter((s) => s.notices === true);
}

function parseStored(raw: string): RegistryNotice[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(isStoredNotice) : [];
  } catch {
    return [];
  }
}

interface CachedNotices {
  notices: RegistryNotice[];
  fetchedAt: number;
}

async function readCache(sources: readonly string[]): Promise<Map<string, CachedNotices>> {
  if (sources.length === 0) return new Map();
  const rows = await db().select().from(registryNotices).where(inArray(registryNotices.source, [...sources]));
  return new Map(rows.map((r): [string, CachedNotices] => [r.source, { notices: parseStored(r.notices), fetchedAt: r.fetchedAt }]));
}

/**
 * 先把 fetched_at 寫成 now 才去抓:同時開好幾個分頁不會一起抓,registry 連不上時 12 小時內
 * 也不會每次進後台都再試一次。回傳搶到的(需要由這個請求去抓的)來源。
 */
async function claimStale(sources: readonly string[], now: number): Promise<Set<string>> {
  const claimed = new Set<string>();
  for (const source of sources) {
    const rows = await db()
      .insert(registryNotices)
      .values({ source, notices: "[]", fetchedAt: now })
      .onConflictDoUpdate({
        target: registryNotices.source,
        set: { fetchedAt: now },
        where: lt(registryNotices.fetchedAt, now - NOTICE_REFRESH_MS),
      })
      .returning({ source: registryNotices.source });
    if (rows.length > 0) claimed.add(source);
  }
  return claimed;
}

/** 寫入一個來源這次讀到的通知(商店讀索引時、背景更新時)。 */
export async function rememberNotices(
  list: readonly { source: string; notices: readonly RegistryNotice[] }[],
  now: number,
): Promise<void> {
  for (const { source, notices } of list) {
    await db()
      .insert(registryNotices)
      .values({ source, notices: JSON.stringify(notices), fetchedAt: now })
      .onConflictDoUpdate({
        target: registryNotices.source,
        set: { notices: sql`excluded.notices`, fetchedAt: sql`excluded.fetched_at` },
      });
  }
}

/**
 * 背景更新:先搶下過期的來源,再各自讀一次 registry.json(3 秒逾時)。永不 throw —— 這是
 * waitUntil 裡的工作,失敗只記錄;快取維持舊的,12 小時後再試。
 */
export async function refreshStaleNotices(sources: readonly RegistrySourceConfig[], now: number): Promise<void> {
  try {
    const claimed = await claimStale(
      sources.map((s) => s.url),
      now,
    );
    const due = sources.filter((s) => claimed.has(s.url));
    const results = await Promise.allSettled(
      due.map(async (config) => ({ source: config.url, notices: await fetchSourceNotices(config) })),
    );
    const fetched = results.flatMap((r, i) => {
      if (r.status === "fulfilled") return [r.value];
      console.error(`[registry-notices] ${due[i].url}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      return [];
    });
    await rememberNotices(fetched, now);
  } catch (e) {
    console.error("[registry-notices] refresh failed", e);
  }
}

export interface NoticeLookup {
  notice: PickedNotice | null;
  /** 快取沒有或超過 12 小時的來源(呼叫端交給 refreshStaleNotices)。 */
  stale: RegistrySourceConfig[];
}

/** 這位管理員現在該看到的那一則,以及需要背景更新的來源。 */
export async function lookupNotice(
  userId: string,
  sources: readonly RegistrySourceConfig[],
  now: number,
): Promise<NoticeLookup> {
  const urls = sources.map((s) => s.url);
  const [cache, seenRows] = await Promise.all([
    readCache(urls),
    db()
      .select()
      .from(registryNoticeSeen)
      .where(eq(registryNoticeSeen.userId, userId))
      .orderBy(desc(registryNoticeSeen.seenAt)),
  ]);
  const stale = sources.filter((s) => {
    const cached = cache.get(s.url);
    return !cached || now - cached.fetchedAt >= NOTICE_REFRESH_MS;
  });
  const notice = pickNotice({
    sources: sources.map((s) => ({ source: s.url, since: s.noticesSince, notices: cache.get(s.url)?.notices ?? [] })),
    seen: new Set(seenRows.map((r) => seenKey(r.source, r.noticeId))),
    lastSeenAt: seenRows[0]?.seenAt ?? null,
    now,
  });
  return { notice, stale };
}

/**
 * 記下「看過」(任何關閉方式都算)。來源必須是打開通知的來源、id 必須合格,否則回 false,
 * 不寫入任何東西。重複記錄不改第一次的時間。
 */
export async function markNoticeSeen(userId: string, source: string, noticeId: string, now: number): Promise<boolean> {
  if (!NOTICE_ID_RE.test(noticeId)) return false;
  const sources = await noticeSources();
  if (!sources.some((s) => s.url === source)) return false;
  await db()
    .insert(registryNoticeSeen)
    .values({ userId, source, noticeId, seenAt: now })
    .onConflictDoNothing();
  return true;
}

