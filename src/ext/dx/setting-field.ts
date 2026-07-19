import type { SettingField } from "../types";
import type { DeclarativeSettingField } from "./manifest";

export function toSettingField(f: DeclarativeSettingField): SettingField {
  const base = {
    key: f.key,
    label: f.label,
    description: f.description,
    default: f.default,
    required: f.required,
    secret: f.secret,
  };
  if (f.type === "select") {
    return { ...base, type: "select", options: f.options ?? [] };
  }
  if (f.type === "number") return { ...base, type: "number" };
  if (f.type === "boolean") return { ...base, type: "boolean" };
  return { ...base, type: f.type };
}
