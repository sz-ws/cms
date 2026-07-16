"use client";

import type { DeclarativeLeafField } from "../manifest";
import { fieldLabel } from "./field-utils";
import { Button } from "@/components/ui/legacy";
import type { Locale } from "@/lib/i18n/index";

// SubmissionsView 的「下載 CSV(本頁)」按鈕。把當頁 rows 組成 CSV 用 Blob 下載。
// v1 範圍:本頁資料;全量匯出需 admin route(follow-up)。

interface Row {
  id: string;
  data: string;
  createdAt: number;
}

interface Props {
  fields: DeclarativeLeafField[];
  rows: Row[];
  fileName: string;
  locale: Locale;
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseData(data: string): Record<string, unknown> {
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function SubmissionsCsvButton({ fields, rows, fileName, locale }: Props) {
  const onExport = () => {
    const header = [...fields.map((f) => fieldLabel(f, locale)), "createdAt"]
      .map(csvCell)
      .join(",");
    const lines = rows.map((r) => {
      const data = parseData(r.data);
      return [
        ...fields.map((f) => csvCell(String(data[f.key] ?? ""))),
        String(r.createdAt),
      ].join(",");
    });
    const csv = `${header}\n${lines.join("\n")}`;
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Button variant="secondary" onClick={onExport}>
      下載 CSV(本頁)
    </Button>
  );
}
