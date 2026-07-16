// Task #7 §2: shared helpers for the /admin/media library. Pure functions only
// — no React here — so both the grid and toolbar can import without pulling
// client-only code into a server context.

export interface StoredFileDTO {
  key: string;
  size: number;
  contentType: string;
}

const IMAGE_CT_RE = /^image\//;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif)$/i;

/** Same image-detection rule as MediaPickerDialog: content-type first, extension fallback. */
export function isImage(file: StoredFileDTO): boolean {
  return IMAGE_CT_RE.test(file.contentType) || IMAGE_EXT_RE.test(file.key);
}

/** Filename portion of a storage key ("<scope>/<yyyy>/<mm>/<name>.<ext>"). */
export function fileNameOf(key: string): string {
  return key.split("/").pop() ?? key;
}

/** Human-readable byte size, e.g. 1536 -> "1.5 KB". */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  const precision = exp === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[exp]}`;
}

/** Short type caption for the card footer, e.g. "image/png" -> "png". */
export function typeLabelOf(file: StoredFileDTO): string {
  const ct = file.contentType.split(";")[0].trim();
  const slash = ct.lastIndexOf("/");
  if (slash >= 0 && slash < ct.length - 1) return ct.slice(slash + 1);
  return ct || "file";
}

/** Client-side filter over an already-loaded page: filename/key/type substring match. */
export function matchesQuery(file: StoredFileDTO, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  return (
    file.key.toLowerCase().includes(q) || file.contentType.toLowerCase().includes(q)
  );
}
