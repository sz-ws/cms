import { getDB } from "./cf";
import { hostsFromApprovedRows } from "./script-hosts";
import {
  COMBINED_STAMP_SQL,
  stampsFromCombinedRow,
  type CombinedStampRow,
  type StampsRecord,
} from "./stamps";

// [core] 冷啟動的合併讀取:isolate 第一次要讀設定與 extension runtime 時,一個 D1 batch 拿齊。
//
// 為什麼:暖的 isolate 靠兩份 memo(settings.ts 的整包設定、ext/loader.ts 的 runtime)
// 一趟 D1 都不用打;冷的 isolate 兩份都是空的,以前要一趟一趟問 —— 設定全表、啟用的
// code extension、內建宣告式插件的列、啟用的宣告式插件,沒有 KV 的站前面還有一趟版本戳。
// 每一趟都要等上一趟回來(loader 要先知道設定才能對齊內建插件),D1 離 Worker 所在機房
// 遠的時候,一趟就一兩百毫秒。這裡把它們放進同一個 batch:一趟。
//
// 為什麼安全:batch 是同一個交易,裡面的版本戳與三張表的內容是同一個時間點的。拿的一方
// (readAll、getExtRuntime)只在「這份讀取的戳 === 這個請求的戳」時才用它的資料,戳一樣
// 就是內容一樣 —— 與兩份 memo 本來的前提相同。對不上(KV 的戳還沒跟上剛剛的寫入、這份
// 讀取是別的請求開始的而中間有人寫入)就照舊自己查。所以不論哪一種請求(公開頁、後台、
// /api)拿到的資料都與以前一樣,只是少了幾趟來回。
//
// 生命週期:每個 module graph 只做一次(RSC、route handler 各自一份,middleware 不用)。
// 兩份資料都有人拿過就不再讓新的請求加入;寫入之後(invalidateSettingsCache /
// invalidateExtRuntimeMemo)立刻丟掉,連還在等的一方也不給。之後的請求一律走原本的路:
// memo 命中就不查,沒命中就各自查自己那一張表。
//
// 版本戳(沒有 KV、或 KV 的副本不能用時):只有**開始**這份讀取的那個請求可以拿它的戳當
// 自己的戳。同時進來的其他請求如果拿它的戳,可能會錯過一筆在它們進來之前、這份讀取開始
// 之後完成的寫入 —— 「寫入在下一個請求就看得見」不能打折,所以它們照舊自己問。

const SETTINGS_SQL = "SELECT key, value FROM settings";
const ENABLED_EXTENSIONS_SQL = "SELECT id FROM extensions WHERE enabled = 1";
const DECLARATIVES_SQL = `SELECT id, manifest, version, enabled, source,
  scripts_approval AS scriptsApproval, updated_at AS updatedAt
  FROM declarative_extensions`;

/** declarative_extensions 的一列,loader(與內建插件的對齊)用得到的欄位。 */
export interface ColdDeclarativeRow {
  id: string;
  manifest: string;
  version: string;
  enabled: number;
  source: string | null;
  scriptsApproval: string | null;
  updatedAt: number;
}

export interface ColdRuntimeRows {
  /** extensions 表裡 enabled = 1 的 id。 */
  enabledExtensionIds: string[];
  /** declarative_extensions 整張表(啟用與停用的都在:內建插件的對齊要看停用的列)。 */
  declaratives: ColdDeclarativeRow[];
}

interface ColdSnapshot extends ColdRuntimeRows {
  /** 與下面的資料同一個交易算的三組戳與 CSP 白名單。 */
  record: StampsRecord;
  settings: Map<string, string>;
}

interface Pending {
  promise: Promise<ColdSnapshot | null>;
  /** 寫入之後丟掉了:還在等這份讀取的一方也不能用。 */
  dropped: boolean;
  settingsTaken: boolean;
  runtimeTaken: boolean;
}

let started = false;
let pending: Pending | null = null;

function manifestScripts(manifest: string): unknown {
  try {
    return (JSON.parse(manifest) as { scripts?: unknown } | null)?.scripts ?? null;
  } catch {
    return null;
  }
}

async function readSnapshot(): Promise<ColdSnapshot | null> {
  const at = Date.now();
  try {
    const d1 = getDB();
    const [stamps, settings, extensions, declaratives] = await d1.batch<unknown>([
      d1.prepare(COMBINED_STAMP_SQL),
      d1.prepare(SETTINGS_SQL),
      d1.prepare(ENABLED_EXTENSIONS_SQL),
      d1.prepare(DECLARATIVES_SQL),
    ]);
    const dxRows = (declaratives.results ?? []) as ColdDeclarativeRow[];
    // 與 script-hosts.ts 的 APPROVED_SCRIPTS_SQL 同一個條件,只是從已經讀回來的列算。
    const hosts = await hostsFromApprovedRows(
      dxRows
        .filter((row) => row.enabled === 1 && row.scriptsApproval !== null)
        .map((row) => ({ scripts: manifestScripts(row.manifest), approval: row.scriptsApproval })),
    );
    const settingRows = (settings.results ?? []) as { key: string; value: string }[];
    return {
      record: {
        ...stampsFromCombinedRow((stamps.results?.[0] ?? null) as CombinedStampRow | null),
        at,
        hosts,
      },
      settings: new Map(settingRows.map((row): [string, string] => [row.key, row.value])),
      enabledExtensionIds: ((extensions.results ?? []) as { id: string }[]).map((row) => row.id),
      declaratives: dxRows,
    };
  } catch {
    // 任一張表不在(剛建好還沒跑完 migration 的庫、測試的最小 DDL)整個 batch 就失敗。
    // 不在這裡記錯:各自照舊查的那條路會重現錯誤,由用到它的一方記。
    return null;
  }
}

/** 這個 module graph 還沒讀過就開始讀;回傳這份讀取,以及是不是這次呼叫開始的。 */
function join(): { entry: Pending; mine: boolean } | null {
  if (!started) {
    started = true;
    pending = { promise: readSnapshot(), dropped: false, settingsTaken: false, runtimeTaken: false };
    return { entry: pending, mine: true };
  }
  return pending ? { entry: pending, mine: false } : null;
}

/**
 * 兩份都有人拿過了就不再讓新的請求加入(資料放掉,memo 已經有了)。已經在等的一方手上
 * 有 entry,照樣拿得到 —— 同一趟讀取、同一個戳,給幾個人用都一樣。
 */
function retireIfDone(entry: Pending): void {
  if (entry.settingsTaken && entry.runtimeTaken && pending === entry) pending = null;
}

/**
 * 版本戳(request-stamps.ts 要去 D1 算戳的時候):只有這次呼叫**開始**了合併讀取才回傳它的
 * 戳(含 CSP 白名單),否則 null —— 呼叫端照舊自己算。永不 throw。
 */
export async function coldStampsRecord(): Promise<StampsRecord | null> {
  if (started) return null;
  const joined = join();
  return joined ? ((await joined.entry.promise)?.record ?? null) : null;
}

/** 整包設定(settings.ts 的 memo 是空的時候)。戳對不上、已經丟掉、讀取失敗 → null。 */
export async function takeColdSettings(stamp: string): Promise<Map<string, string> | null> {
  const joined = join();
  if (!joined) return null;
  const { entry } = joined;
  const snapshot = await entry.promise;
  if (!snapshot || entry.dropped || snapshot.record.settings !== stamp) return null;
  entry.settingsTaken = true;
  retireIfDone(entry);
  return snapshot.settings;
}

/** extension runtime 的列(loader 的 memo 是空的時候)。規則同 takeColdSettings。 */
export async function takeColdRuntimeRows(stamp: string): Promise<ColdRuntimeRows | null> {
  const joined = join();
  if (!joined) return null;
  const { entry } = joined;
  const snapshot = await entry.promise;
  if (!snapshot || entry.dropped || snapshot.record.extensions !== stamp) return null;
  entry.runtimeTaken = true;
  retireIfDone(entry);
  return { enabledExtensionIds: snapshot.enabledExtensionIds, declaratives: snapshot.declaratives };
}

/** 寫入之後(invalidate*):還沒被拿走的資料一律不用了,還在路上的讀取也算。 */
export function dropColdSnapshot(): void {
  if (pending) pending.dropped = true;
  pending = null;
}
