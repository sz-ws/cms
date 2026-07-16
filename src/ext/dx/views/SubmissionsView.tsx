import { getContentProvider, toTypeDef } from "../runtime";
import type { DeclarativeLeafField } from "../manifest";
import { displayValue, fieldLabel, truncate } from "./field-utils";
import { Table, PageTitle } from "@/components/ui/legacy";

// Forms §:admin 看某 form 的提交(declarative 化後:直接查 contents WHERE type='contact.submission')。
// 與舊 form_submissions 走不同路徑;目前改用 ContentProvider 讀共用 contents。

export interface SubmissionsViewProps {
  extId: string;
  formName: string;
  // 為了與 B7 buildForms 相容,formName 保留;實作以 formName 組 type 查 contents
  form: { name: string; label?: string; fields?: { key: string }[] };
  searchParams: Record<string, string>;
}

const PER_PAGE = 20;

export async function SubmissionsView({
  extId,
  formName,
  form,
  searchParams,
}: SubmissionsViewProps) {
  const contentType = `${extId}.${formName}`;
  const page = Math.max(1, Number(searchParams.page ?? "1") || 1);
  const offset = (page - 1) * PER_PAGE;

  const provider = await getContentProvider();
  const { items, total } = await provider.query(contentType, {
    sort: { field: "updatedAt", dir: "desc" },
    page,
    perPage: PER_PAGE,
  });

  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const fields: DeclarativeLeafField[] = (form.fields ?? []) as DeclarativeLeafField[];
  const fileName = `${contentType}.csv`;
  const csvRows = items.map((it) => ({
    id: it.id,
    data: JSON.stringify(it.data ?? {}),
    createdAt: it.createdAt,
  }));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <PageTitle>{form.label ?? form.name} · 提交記錄</PageTitle>
          <p className="mt-1 text-sm text-muted-foreground">共 {total} 筆</p>
        </div>
        {items.length > 0 && (
          <SubmissionsCsvButton
            fields={fields}
            rows={csvRows}
            fileName={fileName}
          />
        )}
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
          尚無提交記錄
        </div>
      ) : (
        <Table
          head={
            <tr>
              {fields.map((f) => (
                <th key={f.key} className="px-3 py-2 font-medium">
                  {fieldLabel(f)}
                </th>
              ))}
              <th className="px-3 py-2 font-medium">時間</th>
            </tr>
          }
        >
          {items.map((s) => (
            <tr key={s.id}>
              {fields.map((f) => (
                <td
                  key={f.key}
                  className="max-w-[24rem] truncate px-3 py-2 align-top"
                >
                  {truncate(displayValue(f as never, s.data[f.key]))}
                </td>
              ))}
              <td className="px-3 py-2 align-top text-muted-foreground">
                {new Date(s.createdAt)
                  .toISOString()
                  .slice(0, 16)
                  .replace("T", " ")}
              </td>
            </tr>
          ))}
        </Table>
      )}

      {pages > 1 && (
        <div className="flex items-center gap-3 text-sm">
          {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
            <a
              key={p}
              href={`?page=${p}`}
              className={
                p === page
                  ? "font-semibold text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }
            >
              {p}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// CSV button 仍用原 client component
import { SubmissionsCsvButton } from "./SubmissionsCsvButton";
