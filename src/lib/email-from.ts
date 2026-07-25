// from-address 的網域套用(EmailDomainChips 用;純函式,獨立成檔以便單元測試
// ——client 元件檔會拖 react 進 workers test pool)。

/** 把 domain 套進現有 from 值:換掉 @ 後綴、保留 local part 與顯示名稱包裝。 */
export function applyEmailDomain(value: string, domain: string): string {
  const wrapped = /^(.*<)([^<>@\s]+)@[^<>\s]*(>.*)$/.exec(value);
  if (wrapped) return `${wrapped[1]}${wrapped[2]}@${domain}${wrapped[3]}`;
  const bare = /^([^@\s]+)@\S*$/.exec(value.trim());
  if (bare) return `${bare[1]}@${domain}`;
  const trimmed = value.trim();
  if (trimmed.length === 0) return `noreply@${domain}`;
  // 只有顯示名稱(如 "Acme")→ 補成 "Acme <noreply@domain>"。
  return `${trimmed} <noreply@${domain}>`;
}
