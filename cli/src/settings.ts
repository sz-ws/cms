// extension manifest 的 `settings[]` —— 讀取、正規化、以及「這一項該落在哪」的規則。
//
// 這個模組是 `add` 的設定問答(configure.ts)與 `preflight` 共用的**唯一**真相來源:
// 兩邊都用 envKeyFor() 推導名稱、都用 storageFor() 判斷落點。分開各寫一份的話,
// 寫入時叫 A、檢查時找 B,preflight 會永遠報「缺」而使用者永遠修不好。
//
// 落點規則(硬性,見 storageFor):
//   secret: false → wrangler.jsonc 的 vars(**會進版控**)
//   secret: true  → .dev.vars(本機、已 gitignore) + 印出 `wrangler secret put`
// cms 是公開 repo。任何 secret 值寫進 vars 都是資安事故,所以判斷只有一個函式,
// 而且有測試守著。

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const SETTING_TYPES = [
  "text",
  "textarea",
  "number",
  "boolean",
  "select",
] as const;
export type SettingType = (typeof SETTING_TYPES)[number];

export interface SettingOption {
  value: string;
  label: string;
}

/** 正規化後的 setting:label/description 已經解析成單一語言的純字串。 */
export interface SettingField {
  key: string;
  label: string;
  description?: string;
  default: unknown;
  required: boolean;
  secret: boolean;
  type: SettingType;
  /** 只有 type === "select" 才非空。 */
  options: SettingOption[];
}

/** 一個 extension 的 settings,加上讀取過程中被跳過的項目(不靜默丟掉)。 */
export interface ExtensionSettings {
  extId: string;
  manifestPath: string;
  settings: SettingField[];
  /** 形狀不合而略過的項目;呼叫端要印出來,否則使用者只會覺得「怎麼沒問我」。 */
  skipped: string[];
}

/** 值的落點。preflight 與 configure 都以此決定「查哪裡 / 寫哪裡」。 */
export type SettingStorage = "vars" | "secret";

/**
 * 🔴 這個函式是那條資安分界本身。
 * `secret: true` 一律回 "secret",沒有任何例外分支 —— 因為 wrangler.jsonc 會進版控。
 */
export function storageFor(field: Pick<SettingField, "secret">): SettingStorage {
  return field.secret ? "secret" : "vars";
}

/**
 * setting key → Worker 環境變數名。
 *
 * 為什麼不直接用 setting key:manifest 的 key 是 extension 內的區域名稱
 * (`apiKey`、`token`),兩個 extension 撞名是常態。而 vars / secret 是**整個
 * Worker 共用的平坦命名空間** —— 直接用 key,後裝的那個會靜默覆蓋先裝的。
 * 所以一律加上 extension 前綴,並轉成環境變數慣用的 UPPER_SNAKE。
 *
 *   newebpay + hashKey → EXT_NEWEBPAY_HASH_KEY
 */
export function envKeyFor(extId: string, key: string): string {
  const ext = extId.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
  const field = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toUpperCase();
  return `EXT_${ext}_${field}`;
}

// ---- localized string ---------------------------------------------------
// manifest 的 label / description 可以是純字串,也可以是 { en, "zh-Hant" }。
// CLI 的其餘輸出都是英文,所以優先 en;只有 zh-Hant 的就用 zh-Hant(總比空白好)。
const LOCALE_ORDER = ["en", "zh-Hant"] as const;

export function localizedText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const locale of LOCALE_ORDER) {
    const candidate = record[locale];
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return undefined;
}

function normalizeOptions(raw: unknown): SettingOption[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SettingOption[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (typeof record.value !== "string") return null;
    out.push({
      value: record.value,
      label: localizedText(record.label) ?? record.value,
    });
  }
  return out;
}

function isSettingType(value: unknown): value is SettingType {
  return (
    typeof value === "string" &&
    (SETTING_TYPES as readonly string[]).includes(value)
  );
}

/**
 * 單一 setting 的正規化。形狀不合回 null(呼叫端記進 skipped)——
 * manifest 可能來自任何一個 registry 來源,不可以假設它一定合規。
 */
export function normalizeSetting(raw: unknown): SettingField | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.key !== "string" || record.key === "") return null;
  if (!isSettingType(record.type)) return null;
  const label = localizedText(record.label) ?? record.key;
  const options = record.type === "select" ? normalizeOptions(record.options) : [];
  if (options === null) return null;
  if (record.type === "select" && options.length === 0) return null;
  return {
    key: record.key,
    label,
    description: localizedText(record.description),
    default: record.default,
    required: record.required === true,
    secret: record.secret === true,
    type: record.type,
    options,
  };
}

/**
 * 讀 extensions/<id>/manifest.json 的 settings[]。
 * 檔案不存在 → null(不是錯誤:code extension 不一定帶 manifest)。
 * 檔案存在但爛掉 → throw,呼叫端要講出來。
 */
export async function readExtensionSettings(
  extensionsDir: string,
  extId: string,
): Promise<ExtensionSettings | null> {
  const manifestPath = path.join(extensionsDir, extId, "manifest.json");
  let text: string;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `extensions/${extId}/manifest.json is not valid JSON: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  const rawSettings =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).settings
      : undefined;
  if (rawSettings === undefined) {
    return { extId, manifestPath, settings: [], skipped: [] };
  }
  if (!Array.isArray(rawSettings)) {
    throw new Error(`extensions/${extId}/manifest.json: settings is not an array`);
  }
  const settings: SettingField[] = [];
  const skipped: string[] = [];
  for (const [i, raw] of rawSettings.entries()) {
    const field = normalizeSetting(raw);
    if (field) settings.push(field);
    else skipped.push(`settings[${i}] shape not recognized, skipped`);
  }
  return { extId, manifestPath, settings, skipped };
}

/**
 * 掃 extensions 底下每個目錄的 manifest.json。找不到目錄 → 空陣列(不是錯誤)。
 * 單一 manifest 壞掉不會中斷整輪 —— 其他 extension 的檢查照跑,壞的那個回報成 error。
 */
export async function collectAllSettings(extensionsDir: string): Promise<{
  extensions: ExtensionSettings[];
  errors: string[];
}> {
  let entries: string[];
  try {
    entries = (await readdir(extensionsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return { extensions: [], errors: [] };
  }
  const extensions: ExtensionSettings[] = [];
  const errors: string[] = [];
  for (const name of entries) {
    try {
      const found = await readExtensionSettings(extensionsDir, name);
      if (found) extensions.push(found);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { extensions, errors };
}

// ---- 值的轉換 -----------------------------------------------------------

export type ParsedValue =
  | { ok: true; value: string | number | boolean }
  | { ok: false; error: string };

/** 把終端輸入的字串轉成該 type 的實際值。boolean 走 confirm,不會走到這裡。 */
export function parseInputValue(type: SettingType, raw: string): ParsedValue {
  if (type === "number") {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) {
      return { ok: false, error: `"${raw}" is not a number` };
    }
    return { ok: true, value: n };
  }
  if (type === "boolean") {
    const lowered = raw.trim().toLowerCase();
    if (["true", "yes", "y", "1"].includes(lowered)) return { ok: true, value: true };
    if (["false", "no", "n", "0"].includes(lowered)) return { ok: true, value: false };
    return { ok: false, error: `"${raw}" is not a boolean` };
  }
  return { ok: true, value: raw };
}

/** default 值拿來當提示字串。undefined / null → 空字串(= 沒有預設)。 */
export function defaultAsText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}
