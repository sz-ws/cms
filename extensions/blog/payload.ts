import { coerceExtraValues, type ExtraFieldDef } from "@/lib/extra-fields";
import type { EntryStatus } from "@/ext/dx/views/StatusToggle";

// blog 編輯版面(layout.tsx)存檔時送出的 body。抽成純函式是為了能測:這裡曾經寫死
// `status: "draft"`,每存一次就把已發佈的文章打回草稿,而版面上又沒有發佈的地方。
//
// 狀態與排程的送法跟泛用 FormView 的 buildData 一致:永遠帶明確的 status 與
// publishAt;已發佈就沒有排程可言,publishAt 清成 null。

export interface BlogPayloadInput {
  /** 標題、slug、摘要、封面、作者、發佈日期(日期是 "YYYY-MM-DD" 字串)。 */
  strings: Record<string, string>;
  body: unknown;
  status: EntryStatus;
  publishAt: number | null;
  extraFields: readonly ExtraFieldDef[];
  extra: Record<string, unknown>;
}

export function buildBlogPayload(input: BlogPayloadInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...input.strings,
    body: input.body,
    status: input.status,
    publishAt: input.status === "published" ? null : input.publishAt,
  };
  if (input.strings.publishedAt) {
    const t = Date.parse(input.strings.publishedAt);
    if (Number.isFinite(t)) payload.publishedAt = t;
  }
  // 額外欄位整包送;這種內容沒有定義就不送,舊值留在 data 裡不動。
  if (input.extraFields.length > 0) {
    payload.extra = coerceExtraValues(input.extraFields, input.extra);
  }
  return payload;
}
