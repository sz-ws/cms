// 試算表安全的 CSV 下載(1.59.0 從 ext/commerce-kit/report.ts 搬來,那裡的 commerceCsv
// 照舊 re-export 這一支)。
//
//   - 開頭放 UTF-8 BOM:Excel(尤其繁中版)沒有 BOM 會把 UTF-8 當成 Big5 打開,中文變亂碼。
//   - 每一格都加雙引號、內部的 " 寫成 ""。
//   - 公式注入:以 = + - @(前面可能有空白或控制字元)開頭的文字,前面加一個 ',Excel /
//     Google 試算表就不會把它當公式執行。數字不加(負數要保持是數字)。
//   - 檔名只留英數與 _ . -,其他換成 _(Content-Disposition 不用處理跳脫)。

/** 一格:null/undefined 是空白,其他轉成字串。 */
function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) && typeof value !== "number") text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** 表格 → CSV 下載回應(第一列通常是表頭)。 */
export function csvResponse(filename: string, rows: readonly (readonly unknown[])[]): Response {
  return new Response("﻿" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename.replace(/[^a-zA-Z0-9_.-]/g, "_")}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
