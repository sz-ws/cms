// 1.56.0:列表的「狀態」篩選可以一次勾好幾個。網址寫法:
//
//   ?status=draft                  一個(舊寫法,照收)
//   ?status=draft,published        逗號分隔(畫面產生的都是這種)
//   ?status=draft&status=published 重複參數(API 呼叫端順手的寫法)
//
// 沒有 status = 全部。值一律對照已知的狀態清單驗:畫面上認不得的值直接略過,
// API 則可以用 invalid 回 400。結果照清單的順序排、去掉重複,同一組條件永遠只有一種網址。
// 純函式:server component、route handler、client 元件都能用。

export const STATUS_PARAM = "status";

/** 單一值最長幾個字(防止有人塞超長參數);狀態 key 本來就短(record-status 的上限 64)。 */
const MAX_TOKEN_LENGTH = 64;

export interface StatusListResult<S extends string> {
  /** 認得的狀態,照 allowed 的順序、沒有重複。空陣列 = 全部。 */
  statuses: S[];
  /** 認不得的值(原樣,去掉前後空白)。 */
  invalid: string[];
}

function tokens(raw: string | readonly string[] | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  const parts = typeof raw === "string" ? [raw] : raw;
  return parts
    .flatMap((part) => part.split(","))
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/** 網址參數(字串、重複參數的陣列或沒有)→ 狀態清單,並列出認不得的值。 */
export function readStatusList<S extends string>(
  raw: string | readonly string[] | null | undefined,
  allowed: readonly S[],
): StatusListResult<S> {
  const found = new Set<string>();
  const invalid: string[] = [];
  for (const token of tokens(raw)) {
    if ((allowed as readonly string[]).includes(token)) found.add(token);
    else invalid.push(token.slice(0, MAX_TOKEN_LENGTH));
  }
  return { statuses: allowed.filter((status) => found.has(status)), invalid };
}

/** 同 readStatusList,但只要認得的(畫面用)。 */
export function parseStatusList<S extends string>(
  raw: string | readonly string[] | null | undefined,
  allowed: readonly S[],
): S[] {
  return readStatusList(raw, allowed).statuses;
}

/** 狀態清單 → 網址參數值;空的回 null(= 拿掉參數)。 */
export function formatStatusList(statuses: readonly string[]): string | null {
  return statuses.length > 0 ? statuses.join(",") : null;
}

/** 勾選或取消一個狀態,回傳新的清單(照 allowed 的順序)。 */
export function toggleStatus<S extends string>(
  selected: readonly S[],
  status: S,
  allowed: readonly S[],
): S[] {
  const next = new Set<S>(selected);
  if (next.has(status)) next.delete(status);
  else next.add(status);
  return allowed.filter((value) => next.has(value));
}

/** 勾到的狀態等於全部(或一個都沒勾)時,查詢不必帶條件。 */
export function coversAllStatuses(selected: readonly string[], allowed: readonly string[]): boolean {
  return selected.length === 0 || allowed.every((status) => selected.includes(status));
}
