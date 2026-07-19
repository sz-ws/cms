export function settingControlId(fullKey: string): string {
  return `setting-${fullKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}
