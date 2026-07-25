import { getLocale } from "@/lib/i18n/server";
import { getMessages } from "@/lib/i18n/index";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import type { LocalizedString } from "@/lib/i18n/localized";
import { listSubmissions, submissionCounts } from "@/lib/submissions";
import {
  SUBMISSION_STATES,
  type SubmissionState,
  isSubmissionState,
} from "../submission";
import type { DeclarativeContentType } from "../manifest";
import { displayValue, fieldLabel, pickTitleField } from "./field-utils";
import { InboxTable, type InboxRowDTO, type InboxFieldMeta } from "./InboxTable";

// 收件匣的 admin surface。CollectionView 的對照組 —— 差別不在樣式,在語意:
//
//   CollectionView 問的是「這篇內容發佈了沒」,所以它有 draft/published 篩選、
//   有「新增」按鈕、有排序表頭、每一列都連到編輯頁。
//   InboxView 問的是「這封訊息我處理了沒」,所以它有 未讀/已讀/已封存 篩選、
//   沒有新增(訊息由外面寄進來)、沒有排序(收件匣是時間序)、列點開的是唯讀詳情。
//
// 資料層走 src/lib/submissions.ts(側表 LEFT JOIN),不經 ContentProvider.query ——
// 因為要過濾的東西(收件狀態)根本不在 contents 表上。
//
// 分頁刻意做成「載入更多之前先給一頁」的簡單 offset:收件匣的自然操作是「處理掉最新
// 的幾封」,不是翻到第 37 頁。URL state 沿用 CollectionView 的慣例(searchParams),
// 所以篩選後的網址可以直接貼給同事。

const PER_PAGE = 25;
/** 詳情面板要顯示的欄位數上限(訊息通常 3–6 欄;超過的部分在唯讀詳情裡仍全列)。 */
const LIST_FIELD_MAX = 3;

export interface InboxViewProps {
  extId: string;
  title: LocalizedString;
  adminSlug: string;
  contentType: DeclarativeContentType;
  searchParams: Record<string, string>;
}

function parseState(raw: string | undefined): SubmissionState | undefined {
  return isSubmissionState(raw) ? raw : undefined;
}

// Date.now() 抽成獨立函式呼叫 —— 直接寫在元件 body / JSX 裡會被 react-hooks/purity
// 擋下(即使這是 Server Component,linter 仍用「PascalCase + 回傳 JSX」的啟發式
// 判斷是元件)。同一手法見 views/FormViewPage.tsx 的 requestTimestamp()。
function requestTimestamp(): number {
  return Date.now();
}

export async function InboxView({
  extId,
  title,
  adminSlug,
  contentType,
  searchParams,
}: InboxViewProps) {
  const locale = await getLocale();
  const t = getMessages(locale);
  const fullType = `${extId}.${contentType.name}`;
  const resolvedTitle =
    resolveLocalizedString(title, locale) ??
    resolveLocalizedString(contentType.label, locale) ??
    contentType.name;

  const state = parseState(searchParams.state);
  const page = Math.max(1, Number(searchParams.page ?? "1") || 1);

  const [{ items, total }, counts] = await Promise.all([
    listSubmissions(fullType, { state, page, perPage: PER_PAGE }),
    submissionCounts(fullType),
  ]);

  // 列表只放前幾個欄位(標題欄優先),完整內容留給詳情面板 —— 一封詢問的重點是
  // 「誰、什麼時候、大概講什麼」,不是把整份表單攤在表格裡。
  const titleField = pickTitleField(contentType.fields, contentType.slugField);
  const listFields = [
    ...(titleField ? [titleField] : []),
    ...contentType.fields.filter((f) => f.key !== titleField?.key),
  ].slice(0, LIST_FIELD_MAX);

  const listMeta: InboxFieldMeta[] = listFields.map((f) => ({
    key: f.key,
    label: fieldLabel(f, locale),
  }));
  // 詳情面板列出**全部**欄位(唯讀)。值在 server 端就格式化好,client 元件不必
  // 認得 DeclarativeField 的型別系統。
  const detailMeta: InboxFieldMeta[] = contentType.fields.map((f) => ({
    key: f.key,
    label: fieldLabel(f, locale),
  }));

  const rows: InboxRowDTO[] = items.map((entry) => ({
    id: entry.id,
    state: entry.state,
    repliedAt: entry.repliedAt,
    createdAt: entry.createdAt,
    cells: listFields.map((f) => displayValue(f, entry.data[f.key])),
    detail: contentType.fields.map((f) => displayValue(f, entry.data[f.key])),
  }));

  const base = `/admin/ext/${extId}${adminSlug ? `/${adminSlug}` : ""}`;
  const tabs = [
    { value: "" as const, label: t["inbox.filter.all"], count: counts.total },
    ...SUBMISSION_STATES.map((s) => ({
      value: s,
      label: t[`inbox.filter.${s}` as keyof typeof t] as string,
      count: counts[s],
    })),
  ];

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-black/90">
          {resolvedTitle}
        </h1>
        <p className="text-[12px] text-black/40">
          {t["inbox.subtitle"]}
        </p>
      </header>

      <InboxTable
        extId={extId}
        typeName={contentType.name}
        rows={rows}
        listFields={listMeta}
        detailFields={detailMeta}
        tabs={tabs}
        activeTab={state ?? ""}
        base={base}
        page={page}
        perPage={PER_PAGE}
        total={total}
        now={requestTimestamp()}
      />
    </div>
  );
}
