import type { LocalizedString } from "@/lib/i18n/localized";
import { isValidAssetFile } from "./registry-asset";
import { parseIsoDate, parseLimitedText } from "./registry-offer";

// 付費插件協定:上新通知(registry.json 頂層的 `notices`)。純資料 + 純函式:解析、挑選。
// 抓取與快取在 registry-notice-store.ts,彈窗在 components/admin/RegistryNoticeDialog.tsx。
//
// 規則(見設計文件「上新通知」):
//   - 每個來源預設關(RegistrySourceConfig.notices),打開時記下 noticesSince
//   - 一則通知只能介紹同一個來源索引裡的插件(extension 必填);找不到就整則丟掉
//   - v1 不收外部網址:registry 不能用 CMS 的彈窗把人帶去任意網站。notice 上的 url 一律不讀
//   - title ≤ 40 字、body ≤ 200 字,純文字,先消毒再算字數;不合格整則丟掉
//   - 挑選:沒看過、在期間內、publishedAt 晚於 noticesSince 的最新一則;
//     同一位管理員 24 小時內最多一則(營運者一次發十則,就分十天)

export const NOTICE_TITLE_MAX = 40;
export const NOTICE_BODY_MAX = 200;
/** 一個來源最多讀幾則(多的忽略),快取與挑選都不必處理無上限的陣列。 */
const MAX_NOTICES = 20;
const NOTICE_ID_RE = /^[a-z0-9-]{1,64}$/;
export const NOTICE_GAP_MS = 24 * 60 * 60 * 1000;

export interface RegistryNotice {
  /** 同一來源內唯一;「看過」記的就是它。 */
  id: string;
  title: LocalizedString;
  body?: LocalizedString;
  /** 同一來源索引裡的插件 id(「查看」開它的詳情頁)。 */
  extension: string;
  /** 以下三個從索引裡那個插件的條目帶過來,彈窗不必再讀一次索引。 */
  extensionName: string;
  /** 插件的 banner 檔名(通過 isValidAssetFile 才留);彈窗經 /api/registry/asset 顯示。 */
  banner?: string;
  /** 插件版本:asset 網址的快取鍵。 */
  version: string;
  publishedAt: string;
  expiresAt?: string;
}

/** 索引條目裡通知用得到的欄位。 */
export interface NoticeEntryRef {
  id: string;
  name: string;
  version: string;
  banner?: string;
}

function parseNotice(raw: unknown, entries: ReadonlyMap<string, NoticeEntryRef>): RegistryNotice | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !NOTICE_ID_RE.test(r.id)) return null;
  const entry = typeof r.extension === "string" ? entries.get(r.extension) : undefined;
  if (!entry) return null;
  const title = parseLimitedText(r.title, NOTICE_TITLE_MAX);
  const body = parseLimitedText(r.body, NOTICE_BODY_MAX);
  if (!title.ok || title.value === undefined || !body.ok) return null;
  const publishedAt = parseIsoDate(r.publishedAt);
  const expiresAt = parseIsoDate(r.expiresAt);
  if (!publishedAt || (r.expiresAt !== undefined && !expiresAt)) return null;
  return {
    id: r.id,
    title: title.value,
    ...(body.value !== undefined ? { body: body.value } : {}),
    extension: entry.id,
    extensionName: entry.name,
    ...(entry.banner && isValidAssetFile(entry.banner) ? { banner: entry.banner } : {}),
    version: entry.version,
    publishedAt,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

/**
 * registry.json → 驗證過的通知。entries 是同一份索引解析出來的條目(只有它們可以被介紹)。
 * 同一個 id 出現兩次只留第一則。
 */
export function parseNotices(json: unknown, entries: readonly NoticeEntryRef[]): RegistryNotice[] {
  if (!json || typeof json !== "object") return [];
  const list = (json as { notices?: unknown }).notices;
  if (!Array.isArray(list)) return [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const out: RegistryNotice[] = [];
  for (const raw of list.slice(0, MAX_NOTICES)) {
    const notice = parseNotice(raw, byId);
    if (notice && !out.some((n) => n.id === notice.id)) out.push(notice);
  }
  return out;
}

/** 從快取讀回來的資料再過一次形狀檢查(表裡的 JSON 不當作一定可信)。 */
export function isStoredNotice(value: unknown): value is RegistryNotice {
  if (!value || typeof value !== "object") return false;
  const n = value as Record<string, unknown>;
  return (
    typeof n.id === "string" &&
    NOTICE_ID_RE.test(n.id) &&
    typeof n.extension === "string" &&
    typeof n.extensionName === "string" &&
    typeof n.version === "string" &&
    parseIsoDate(n.publishedAt) !== undefined &&
    (n.expiresAt === undefined || parseIsoDate(n.expiresAt) !== undefined) &&
    (typeof n.title === "string" || (typeof n.title === "object" && n.title !== null)) &&
    (n.banner === undefined || (typeof n.banner === "string" && isValidAssetFile(n.banner)))
  );
}

export interface SourceNotices {
  source: string;
  /** 這個來源打開通知的時間(ISO)。沒有 = 不挑。 */
  since: string | undefined;
  notices: readonly RegistryNotice[];
}

export interface PickedNotice extends RegistryNotice {
  source: string;
}

export interface PickInput {
  sources: readonly SourceNotices[];
  /** 這位管理員看過的:`<source>\n<notice id>`。 */
  seen: ReadonlySet<string>;
  /** 這位管理員最後一次看過任何一則的時間(epoch ms);沒有 = null。 */
  lastSeenAt: number | null;
  now: number;
}

export function seenKey(source: string, id: string): string {
  return `${source}\n${id}`;
}

function inWindow(notice: RegistryNotice, since: number, now: number): boolean {
  const published = Date.parse(notice.publishedAt);
  if (!(published > since) || published > now) return false;
  return notice.expiresAt === undefined || now < Date.parse(notice.expiresAt);
}

/** 這次要跳的那一則;沒有就 null。 */
export function pickNotice({ sources, seen, lastSeenAt, now }: PickInput): PickedNotice | null {
  if (lastSeenAt !== null && now - lastSeenAt < NOTICE_GAP_MS) return null;
  const candidates = sources.flatMap(({ source, since, notices }) => {
    const sinceMs = since === undefined ? Number.NaN : Date.parse(since);
    if (Number.isNaN(sinceMs)) return [];
    return notices
      .filter((n) => !seen.has(seenKey(source, n.id)) && inWindow(n, sinceMs, now))
      .map((n): PickedNotice => ({ ...n, source }));
  });
  const newest = candidates.sort(
    (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.id.localeCompare(b.id),
  )[0];
  return newest ?? null;
}
