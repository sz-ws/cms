/** Spreadsheet-safe CSV, with a BOM for Traditional Chinese Excel imports. */
export function commerceCsv(filename: string, rows: readonly (readonly unknown[])[]) {
  const cell = (value: unknown) => {
    let text = value == null ? "" : String(value);
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) && typeof value !== "number") text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return new Response("\ufeff" + rows.map((row) => row.map(cell).join(",")).join("\r\n"), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename.replace(/[^a-zA-Z0-9_.-]/g, "_")}"`, "Cache-Control": "private, no-store" },
  });
}
