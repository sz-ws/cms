// core-v2 §1:極簡 semver range 檢查器。刻意不引入完整 semver lib。
// 僅支援 exact("1.2.3")、caret("^1.2.3")、tilde("~1.2.3")、gte(">=1.2.3")。
// 純函式、無 I/O、無 regex 於使用者可控輸入之外的路徑。

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

/**
 * version 是否滿足 range。range 支援:
 *   "1.2.3"    exact
 *   "^1.2.3"   caret:>=1.2.3 且 <2.0.0(major 為 0 時仍以 major 為界)
 *   "~1.2.3"   tilde:>=1.2.3 且 <1.3.0
 *   ">=1.2.3"  gte
 * 無法解析的 range 或 version → false(fail closed)。
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

/** Whether the minimum version named by a supported range is >= `minimum`. */
export function rangeStartsAtOrAfter(range: string, minimum: string): boolean {
  const min = parse(minimum);
  if (!min) return false;
  const trimmed = range.trim();
  const baseText = trimmed.startsWith(">=")
    ? trimmed.slice(2)
    : trimmed.startsWith("^") || trimmed.startsWith("~")
      ? trimmed.slice(1)
      : trimmed;
  const base = parse(baseText);
  return base ? compare(base, min) >= 0 : false;
}
