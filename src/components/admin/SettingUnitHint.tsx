"use client";

import type { MessageKey } from "@/lib/i18n/index";
import { useT } from "@/lib/i18n/I18nProvider";
import type { SettingNumberUnit } from "@/lib/settings";

// 數字設定的單位換算(1.52.0 SettingField.unit):存的值不變,欄位旁邊寫成好讀的說法。
// 1440 分鐘 → 「= 24 小時」、90 → 「= 1 小時 30 分鐘」、4320 → 「= 3 天」。
// 兩天以內用小時(付款期限這類設定大家講「24 小時」「36 小時」),再長才換成天。
// 不到一小時、空白或不是正整數時不顯示:欄位標題已經寫了單位。

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const HOURS_ONLY_BELOW = 2 * MINUTES_PER_DAY;

type Part = { n: number; one: MessageKey; many: MessageKey };

/** 分鐘數拆成天、小時、分鐘(零的部分省略);不到一小時回空陣列。 */
export function minutesToParts(minutes: number): Part[] {
  if (!Number.isInteger(minutes) || minutes < MINUTES_PER_HOUR) return [];
  const days = minutes >= HOURS_ONLY_BELOW ? Math.floor(minutes / MINUTES_PER_DAY) : 0;
  const rest = minutes - days * MINUTES_PER_DAY;
  const hours = Math.floor(rest / MINUTES_PER_HOUR);
  const mins = rest % MINUTES_PER_HOUR;
  const parts: Part[] = [
    { n: days, one: "settingsWorkspace.duration.day", many: "settingsWorkspace.duration.days" },
    { n: hours, one: "settingsWorkspace.duration.hour", many: "settingsWorkspace.duration.hours" },
    { n: mins, one: "settingsWorkspace.duration.minute", many: "settingsWorkspace.duration.minutes" },
  ];
  return parts.filter((part) => part.n > 0);
}

export function SettingUnitHint({
  id,
  unit,
  value,
}: {
  id: string;
  unit: SettingNumberUnit;
  value: unknown;
}) {
  const t = useT();
  const raw = typeof value === "string" ? value.trim() : value;
  const minutes = unit === "minutes" && raw !== "" ? Number(raw) : Number.NaN;
  const parts = minutesToParts(minutes);
  if (parts.length === 0) return null;
  const text = parts.map((part) => t(part.n === 1 ? part.one : part.many, { n: part.n })).join(" ");
  return (
    <span id={id} className="shrink-0 text-[13px] tabular-nums text-ink/45">
      {t("settingsWorkspace.unitEquals", { value: text })}
    </span>
  );
}
