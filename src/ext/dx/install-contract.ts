export function migrationHistoryChanged(
  previous: readonly string[],
  next: readonly string[],
): boolean {
  return (
    next.length < previous.length ||
    previous.some((sql, index) => next[index] !== sql)
  );
}

export function isStaleInstallConflict(error: unknown): boolean {
  const parts: string[] = [];
  let current = error;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return /UNIQUE constraint failed: ext_migrations\.id/i.test(parts.join(" | "));
}
