// coreApi 相容性檢查 —— 把「裝了也啟用不了」的失敗提前到安裝當下。
//
// 沒有這一關的話:CLI 照樣落地檔案 + patch registry.ts,人類 rebuild + deploy,直到在
// admin 按 Enable 那一刻 src/ext/manager.ts 的 enableExtension() 才丟 CoreApiIncompatible。
//
// 為什麼在 CLI 重抄一份而不是 import src/:
//   CLI 是獨立編譯的純 node 程式(cli/tsconfig.json 的 rootDir = cli/src),import
//   src/ext/* 會把整個 Next 的 module graph 拖進 npx 包裡。所以:
//     - CORE_API_VERSION 用 regex 從 src/ext/version.ts 的原始碼撈(不 import、不執行)
//     - satisfies() 照抄 src/ext/semver.ts 的語意(exact / ^ / ~ / >=,fail closed)
//   兩份是**刻意的重複**:src/ext/semver.ts 的判定語意若改動,這裡必須跟著改,否則 CLI
//   放行的 extension 到 Enable 那步仍會被 core 擋下 —— 那就白檢查了。

import { readFile } from "node:fs/promises";
import path from "node:path";

type Ver = readonly [number, number, number];

/** 解析 "x.y.z" → [x,y,z];非法回傳 null(不 throw,交呼叫端判斷)。 */
function parse(v: string): Ver | null {
  const parts = v.trim().split(".");
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return [nums[0], nums[1], nums[2]] as const;
}

/** a < b → -1, a === b → 0, a > b → 1(逐段比較)。 */
function compare(a: Ver, b: Ver): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

/** range 去掉運算子後的版本字串;不支援的形式回 null。 */
function rangeBase(range: string): string {
  const trimmed = range.trim();
  if (trimmed.startsWith(">=")) return trimmed.slice(2);
  if (trimmed.startsWith("^") || trimmed.startsWith("~")) return trimmed.slice(1);
  return trimmed;
}

/** 這支 CLI(與 core)看得懂的 range 形式嗎?看不懂 → 訊息要換一種講法。 */
export function isSupportedRange(range: string): boolean {
  return parse(rangeBase(range)) !== null;
}

/**
 * version 是否滿足 range。語意與 src/ext/semver.ts 的 satisfies 相同:
 *   "1.2.3"    exact
 *   "^1.2.3"   caret:>=1.2.3 且同 major(major 為 0 時仍以 major 為界)
 *   "~1.2.3"   tilde:>=1.2.3 且同 major.minor
 *   ">=1.2.3"  gte
 * 無法解析的 range 或 version → false(fail closed,與 core 一致)。
 */
export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  const trimmed = range.trim();

  if (trimmed.startsWith(">=")) {
    const base = parse(trimmed.slice(2));
    return base ? compare(v, base) >= 0 : false;
  }
  if (trimmed.startsWith("^")) {
    const base = parse(trimmed.slice(1));
    if (!base) return false;
    if (compare(v, base) < 0) return false;
    return v[0] === base[0]; // caret:同 major
  }
  if (trimmed.startsWith("~")) {
    const base = parse(trimmed.slice(1));
    if (!base) return false;
    if (compare(v, base) < 0) return false;
    return v[0] === base[0] && v[1] === base[1]; // tilde:同 major.minor
  }
  const exact = parse(trimmed);
  return exact ? compare(v, exact) === 0 : false;
}

/** 本機 core 版號的來源檔(相對於 CMS repo 根目錄);錯誤訊息會指這個路徑。 */
export const CORE_VERSION_FILE = "src/ext/version.ts";

/**
 * 從 <cwd>/src/ext/version.ts 撈 `export const CORE_API_VERSION = "x.y.z";`。
 * 讀不到檔或撈不到常數 → null(呼叫端當「無法判定」處理,不是失敗)。
 * 刻意只做文字比對:import 那個檔會把 Next module graph 拉進純 node 的 CLI。
 */
export async function readCoreApiVersion(cwd: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(path.join(cwd, ...CORE_VERSION_FILE.split("/")), "utf8");
  } catch {
    return null;
  }
  const m = text.match(
    /^\s*export\s+const\s+CORE_API_VERSION\s*(?::\s*string\s*)?=\s*["']([^"']+)["']/m,
  );
  return m ? m[1] : null;
}

export type CoreApiVerdict =
  /** 本機 core 滿足 entry 宣告的 range。 */
  | { status: "ok"; core: string }
  /** 不滿足 —— 裝下去 Enable 一定被擋。unsupportedRange:range 形式連 core 都解析不了。 */
  | { status: "incompatible"; core: string; unsupportedRange: boolean }
  /** 讀不到本機 core 版號(不在 CMS repo?版號檔搬家?)→ 只警告,不擋。 */
  | { status: "unknown" };

/** 純函式判定;core 為 readCoreApiVersion() 的結果。 */
export function checkCoreApi(core: string | null, range: string): CoreApiVerdict {
  // 版號檔在、但常數形狀不對(例如手改成 "1.18")→ 一樣當無法判定,不亂擋。
  if (core === null || parse(core) === null) return { status: "unknown" };
  if (satisfies(core, range)) return { status: "ok", core };
  return { status: "incompatible", core, unsupportedRange: !isSupportedRange(range) };
}
