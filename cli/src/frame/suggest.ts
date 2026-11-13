// "Did you mean" for unknown commands and flags: the nearest candidate by edit
// distance, or nothing when every candidate is far away.

/** Optimal string alignment distance: insertions, deletions, substitutions and adjacent swaps. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * The closest candidate, if it is close enough to be a plausible typo:
 * at most a third of the input's length (minimum 1, maximum 3 edits),
 * or the input is a prefix of exactly one candidate.
 */
export function nearest(input: string, candidates: readonly string[]): string | undefined {
  const prefixed = candidates.filter((c) => input.length >= 2 && c.startsWith(input));
  if (prefixed.length === 1) return prefixed[0];
  const limit = Math.min(3, Math.max(1, Math.floor(input.length / 3)));
  let best: { name: string; distance: number } | undefined;
  for (const name of candidates) {
    const distance = editDistance(input, name);
    if (distance <= limit && (!best || distance < best.distance)) best = { name, distance };
  }
  return best?.name;
}
