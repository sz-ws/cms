import type { LocalizedString } from "@/lib/i18n/localized";

// 1.40.0:插件紀錄的狀態(訂單、經銷訂單、佣金…)統一定義,站台可以補描述。
//
// 以前每個插件自己寫一份「狀態 → 中文 → 顏色」,同一個狀態在不同頁叫不同名字
// (待對帳/匯款待核實)、顏色也不一樣。現在:
//
//   - 插件在定義裡宣告 `statusSets`:每個狀態的名稱與色調。全站識別是
//     `<extId>:<setId>`,例如 "shop-operations:orders"。
//   - 站台用 filter:statusSets 這個 slot 改名(label)或補一段描述(addon)——
//     系統狀態本身不變(它綁著庫存、金流、佣金),只改後台怎麼講。只在後台顯示。
//   - 每一筆紀錄在某個狀態下還可以另外掛一段描述(lib/record-status-notes.ts,
//     可由端點設定);換了狀態,舊階段的描述就不再顯示。
//   - 後台用 <StatusBadge> 畫:狀態名稱,有描述時後面一個小圖示,滑上去看說明。

export const STATUS_TONES = ["neutral", "amber", "green", "red", "accent"] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

export interface StatusDef {
  label: LocalizedString;
  /** 缺省 neutral。 */
  tone?: StatusTone;
}

/** Extension.statusSets 的一項。 */
export interface StatusSetDecl {
  /** extension 內唯一;全站識別是 `<extId>:<id>`。 */
  id: string;
  statuses: Record<string, StatusDef>;
}

export interface ResolvedStatus {
  label: string;
  tone: StatusTone;
  /** 站台補的描述(filter:statusSets);只在後台顯示。 */
  addon?: string;
}

/** `<extId>:<setId>` → 狀態值 → 解析好的名稱、色調、描述。 */
export type ResolvedStatusSets = Record<string, Record<string, ResolvedStatus>>;

export const STATUS_SET_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const STATUS_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const STATUS_REF_RE = /^[a-z][a-z0-9-]{1,30}:[a-z][a-z0-9-]{0,39}$/;

export function isStatusSetRef(value: string): boolean {
  return STATUS_REF_RE.test(value);
}

/** 一組宣告 → 解析好的狀態(名稱依語系)。 */
export function resolveStatusSet(
  decl: StatusSetDecl,
  resolve: (value: LocalizedString) => string | undefined,
): Record<string, ResolvedStatus> {
  return Object.fromEntries(
    Object.entries(decl.statuses).map(([key, def]) => [
      key,
      { label: resolve(def.label) || key, tone: def.tone ?? "neutral" },
    ]),
  );
}

/** 啟用中的 extensions → 全部狀態組(過 filter:statusSets 之前)。 */
export function resolveStatusSets(
  exts: readonly { id: string; statusSets?: StatusSetDecl[] }[],
  resolve: (value: LocalizedString) => string | undefined,
): ResolvedStatusSets {
  const out: ResolvedStatusSets = {};
  for (const ext of exts) {
    for (const decl of ext.statusSets ?? []) {
      out[`${ext.id}:${decl.id}`] = resolveStatusSet(decl, resolve);
    }
  }
  return out;
}

const MAX_LABEL = 40;
const MAX_ADDON = 200;

/**
 * filter:statusSets 的輸出是站台給的,渲染前在這裡收斂:只能改既有的組與狀態
 * (不能憑空加狀態 —— 系統不會產生它),名稱與描述必須是字串且有長度上限,
 * 色調只收已知值。壞掉的欄位退回原值,不讓一個寫錯的 filter 弄壞整個後台。
 */
export function normalizeStatusSets(value: unknown, base: ResolvedStatusSets): ResolvedStatusSets {
  if (!value || typeof value !== "object") return base;
  const input = value as Record<string, unknown>;
  const out: ResolvedStatusSets = {};
  for (const [ref, statuses] of Object.entries(base)) {
    const overrides = input[ref];
    out[ref] = {};
    for (const [key, status] of Object.entries(statuses)) {
      const raw =
        overrides && typeof overrides === "object"
          ? (overrides as Record<string, unknown>)[key]
          : undefined;
      if (!raw || typeof raw !== "object") {
        out[ref][key] = status;
        continue;
      }
      const { label, tone, addon } = raw as Record<string, unknown>;
      out[ref][key] = {
        label: typeof label === "string" && label.trim() ? label.trim().slice(0, MAX_LABEL) : status.label,
        tone: STATUS_TONES.includes(tone as StatusTone) ? (tone as StatusTone) : status.tone,
        ...(typeof addon === "string" && addon.trim()
          ? { addon: addon.trim().slice(0, MAX_ADDON) }
          : status.addon
            ? { addon: status.addon }
            : {}),
      };
    }
  }
  return out;
}

/** 色調 → 後台 pill 的 class(Paper & Ink;accent 跟著後台主色)。 */
export const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  neutral: "bg-black/[0.05] text-black/55",
  amber: "bg-amber-500/10 text-amber-700",
  green: "bg-[rgba(16,145,90,0.10)] text-[rgb(18,124,88)]",
  red: "bg-red-600/10 text-red-700",
  accent: "bg-(--admin-accent)/10 text-(--admin-accent)",
};
