import type { DeclarativeContentType } from "./manifest";

const RESERVED_PUBLIC_KEYS = new Set([
  "status",
  "slug",
  "id",
  "createdAt",
  "updatedAt",
]);

export function sanitizePublicCreateBody(
  body: Record<string, unknown>,
  ct: DeclarativeContentType,
): Record<string, unknown> {
  const allowed = new Set(ct.fields.map((field) => field.key));
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key) || RESERVED_PUBLIC_KEYS.has(key)) continue;
    next[key] = value;
  }
  return next;
}
