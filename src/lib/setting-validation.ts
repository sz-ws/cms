import { normalizeHex } from "./color";
import { adminThemeSchema } from "./admin-theme";
import { EXTRA_FIELDS_SETTING, extraFieldsSettingSchema } from "./extra-fields";
import { isIsoDay, isNoticeLink, isPlainLine, textLength } from "./site-notice";

export type SettingValueField = {
  key: string;
  type: "text" | "textarea" | "number" | "boolean" | "select" | "color";
  required?: boolean;
  secret?: boolean;
  options?: readonly { value: string }[];
  /** 1.56.0:text 的格式與字數上限(只有 core 設定會帶)。 */
  format?: "line" | "link" | "date";
  maxLength?: number;
};

export type SettingValueErrorCode =
  | "required"
  | "expected_string"
  | "expected_number"
  | "expected_boolean"
  | "invalid_option"
  | "invalid_color"
  | "invalid_theme"
  | "invalid_extra_fields"
  | "too_long"
  | "not_plain_text"
  | "invalid_link"
  | "invalid_date"
  | "not_serializable";

export interface SettingValueError {
  key: string;
  code: SettingValueErrorCode;
}

/** 1.56.0:text 欄位的字數與格式(format / maxLength 都沒給就不檢查)。 */
function textFieldError(
  field: SettingValueField,
  value: string,
): SettingValueErrorCode | null {
  const trimmed = value.trim();
  if (field.maxLength !== undefined && textLength(trimmed) > field.maxLength) {
    return "too_long";
  }
  switch (field.format) {
    case "line":
      return isPlainLine(value) ? null : "not_plain_text";
    case "link":
      return isNoticeLink(trimmed) ? null : "invalid_link";
    case "date":
      return isIsoDay(trimmed) ? null : "invalid_date";
    default:
      return null;
  }
}

function isJsonSerializable(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Authoritative value check shared by core settings, code/declarative extension
 * settings, install prompts and the settings API. `textarea` intentionally
 * accepts JSON values: existing core settings use it for arrays/objects and the
 * admin editor parses JSON-looking input before submission.
 */
export function validateSettingValue(
  field: SettingValueField,
  value: unknown,
): SettingValueErrorCode | null {
  if (field.key === "core.adminTheme") {
    return value === null || adminThemeSchema.safeParse(value).success ? null : "invalid_theme";
  }
  // 額外欄位的定義一路影響 CRUD 寫入與對外出口(哪些值算公開),所以不能只看「是不是
  // JSON」:整份照 schema 驗,重複代號、超過上限都在這裡擋掉。
  if (field.key === EXTRA_FIELDS_SETTING) {
    return extraFieldsSettingSchema.safeParse(value).success ? null : "invalid_extra_fields";
  }
  const empty =
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0);
  if (field.required && empty) return "required";
  if (empty) return null;
  if (field.secret && typeof value !== "string") return "expected_string";

  switch (field.type) {
    case "text":
      return typeof value === "string" ? textFieldError(field, value) : "expected_string";
    case "textarea":
      return typeof value === "string" || isJsonSerializable(value)
        ? null
        : "not_serializable";
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : "expected_number";
    case "boolean":
      return typeof value === "boolean" ? null : "expected_boolean";
    case "select":
      if (typeof value !== "string") return "expected_string";
      return (field.options ?? []).some((option) => option.value === value)
        ? null
        : "invalid_option";
    case "color":
      // 會被拼進 CSS(後台主色):只收正規化過的 #rrggbb。
      if (typeof value !== "string") return "expected_string";
      return normalizeHex(value) === value ? null : "invalid_color";
  }
}

/** Existing persisted values are safe only when their storage contract stays stable. */
export function incompatibleSettingContract(
  previous: readonly SettingValueField[],
  next: readonly SettingValueField[],
): string[] {
  const nextByKey = new Map(next.map((field) => [field.key, field]));
  const changed: string[] = [];
  for (const oldField of previous) {
    const newField = nextByKey.get(oldField.key);
    if (!newField) {
      changed.push(oldField.key);
      continue;
    }
    const oldOptions =
      oldField.type === "select"
        ? (oldField.options ?? []).map((option) => option.value)
        : [];
    const newOptions =
      newField.type === "select"
        ? (newField.options ?? []).map((option) => option.value)
        : [];
    if (
      oldField.type !== newField.type ||
      Boolean(oldField.secret) !== Boolean(newField.secret) ||
      Boolean(oldField.required) !== Boolean(newField.required) ||
      oldOptions.length !== newOptions.length ||
      oldOptions.some((value, index) => value !== newOptions[index])
    ) {
      changed.push(oldField.key);
    }
  }
  return changed;
}

export function validateSettingEntries(
  fields: ReadonlyMap<string, SettingValueField>,
  entries: Record<string, unknown>,
): SettingValueError[] {
  const errors: SettingValueError[] = [];
  for (const [key, value] of Object.entries(entries)) {
    const field = fields.get(key);
    if (!field) continue;
    const code = validateSettingValue(field, value);
    if (code) errors.push({ key, code });
  }
  return errors;
}

/** Preserve an empty numeric control as empty; never coerce it to numeric 0. */
export function coerceSettingInput(
  field: Pick<SettingValueField, "type">,
  value: string | boolean,
): unknown {
  if (field.type === "number") return value === "" ? null : Number(value);
  return value;
}
