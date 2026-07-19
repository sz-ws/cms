export type SettingValueField = {
  key: string;
  type: "text" | "textarea" | "number" | "boolean" | "select";
  required?: boolean;
  secret?: boolean;
  options?: readonly { value: string }[];
};

export type SettingValueErrorCode =
  | "required"
  | "expected_string"
  | "expected_number"
  | "expected_boolean"
  | "invalid_option"
  | "not_serializable";

export interface SettingValueError {
  key: string;
  code: SettingValueErrorCode;
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
  const empty =
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0);
  if (field.required && empty) return "required";
  if (empty) return null;
  if (field.secret && typeof value !== "string") return "expected_string";

  switch (field.type) {
    case "text":
      return typeof value === "string" ? null : "expected_string";
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
