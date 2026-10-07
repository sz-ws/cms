import { resolveLocalizedString, type LocalizedString } from "@/lib/i18n/localized";
import type { Locale } from "@/lib/i18n";
import { isSitePath } from "./site-path";
import { defineValueSlot, type SlotRegistry } from "./slots";

// 「我的帳戶」那一區的項目(core 1.74.0;插槽的機制見 slots.ts)。
//
// 登入的人能去的帳戶頁分散在各個插件:我的訂單、經銷專區、推廣中心、會員資料…。有這種頁的插件各加一項
// (AccountEntries),畫帳戶總覽的那一方(例如站台自己的會員中心)用 accountEntriesFor() 讀出來,
// 決定怎麼排、配什麼圖示。core 自己不畫。
//
// 沒有這個之前,畫總覽的那一頁要自己知道有哪些插件、各自去問它們的內部函式。
//
// 插件這樣加:
//   fill(AccountEntries, (entries) => [...entries, { key: "orders", href: "/shop/orders", label: "我的訂單", note }])
// 一定要 append(`[...entries, X]`),不要整包換掉。

/** 登入的那個人。 */
export interface AccountPerson {
  id: string;
  role: "admin" | "editor" | "guest";
}

export interface AccountEntry {
  /** 穩定的代號(小寫英數與 -);畫的那一方用它排順序、配圖示。同一個代號後填的蓋掉先填的。 */
  key: string;
  /** 站內路徑。 */
  href: string;
  /** 一種語言的插件給字串;有翻譯的給每種語言各一份。 */
  label: LocalizedString;
  /**
   * 這個人現在的狀態,一句話(例:「2 筆待回報匯款」)。有翻譯的插件照 locale 寫,只有一種語言的照自己的語言。
   * 回 null = 這個人用不到這一項,不要畫(例:不是經銷商、也沒開放申請)。查不到資料時自己退回一句通用的說明;
   * 丟例外的話這一項會被跳過。
   */
  note(person: AccountPerson, locale: Locale): Promise<string | null>;
}

/** 讀出來、問過狀態的一項。 */
export interface ResolvedAccountEntry {
  key: string;
  href: string;
  label: string;
  note: string;
}

export const AccountEntries = defineValueSlot<AccountEntry[]>("account.entries");

const KEY_RE = /^[a-z][a-z0-9-]{0,39}$/;

function isLabel(value: unknown): value is LocalizedString {
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value !== "object" || value === null) return false;
  const texts = Object.values(value);
  return texts.length > 0 && texts.every((text) => typeof text === "string" && text.trim() !== "");
}

function isEntry(value: unknown): value is AccountEntry {
  if (typeof value !== "object" || value === null) return false;
  const { key, href, label, note } = value as Record<string, unknown>;
  return typeof key === "string" && KEY_RE.test(key) && isSitePath(href) && isLabel(label) && typeof note === "function";
}

/**
 * 填的人給的清單收斂:寫壞的丟掉並記一筆(不然看起來跟「這個人用不到」一樣,很難查);
 * 同一個代號留最後填的那一份(站台可以用同一個代號換掉插件的說法),位置照第一次出現的。
 */
function normalize(value: unknown): AccountEntry[] {
  if (!Array.isArray(value)) return [];
  const byKey = new Map<string, AccountEntry>();
  for (const item of value) {
    if (isEntry(item)) byKey.set(item.key, item);
    else console.error("[account-entries] dropped an entry that is not { key, href (a site path), label, note() }", item);
  }
  return [...byKey.values()];
}

/**
 * 這個人的帳戶項目,用 locale 那個語言:照插件填的先後,每一項問過現在的狀態(同時問)。狀態是 null 或空的不列;
 * 問的時候丟例外的那一項記下來、跳過,其他照常。
 */
export async function accountEntriesFor(slots: SlotRegistry, person: AccountPerson, locale: Locale): Promise<ResolvedAccountEntry[]> {
  const entries = normalize(slots.value(AccountEntries, []));
  const notes = await Promise.all(
    entries.map(async (entry) => {
      try {
        const note = await entry.note(person, locale);
        return typeof note === "string" && note.trim() !== "" ? note : null;
      } catch (error) {
        console.error(`[account-entries] "${entry.key}" could not tell its status`, error);
        return null;
      }
    }),
  );
  return entries.flatMap(({ key, href, label }, index) => {
    const note = notes[index];
    const name = resolveLocalizedString(label, locale);
    return note === null || name === undefined ? [] : [{ key, href, label: name, note }];
  });
}
