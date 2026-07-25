import { PageTitle } from "@/components/ui/legacy";
import { getContentProvider, toTypeDef } from "../runtime";
import { getContentPublishAt } from "../content-provider";
import type { DeclarativeContentType } from "../manifest";
import { AdminFormSurface } from "./AdminFormSurface";
import { RevisionHistory, type RevisionRowDTO } from "./RevisionHistory";
import { listRevisions } from "@/lib/revisions";
import { inferCardConfig } from "./collection/card-config";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { format } from "@/lib/i18n/index";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import type { LocalizedString } from "@/lib/i18n/localized";

// admin create/edit 頁(server component)。edit 模式(?id=…)先載入既有 entry,
// 再交給 client surface。Surface 先嘗試固定入口 layout.tsx 註冊的元件,
// 沒有就用 generic FormView(走 contentType.layout 的 auto2col/single/manual)。

// Date.now() 抽成獨立函式呼叫 —— 直接寫在元件 body / JSX 裡會被 react-hooks/purity
// 判定為「元件內呼叫 impure function」而擋下(即使這是 Server Component,linter 仍用
// 「PascalCase + 回傳 JSX」的啟發式判斷是元件)。同一手法見
// src/app/(admin)/admin/account/page.tsx 的 requestTimestamp()。
function requestTimestamp(): number {
  return Date.now();
}

export interface FormViewPageProps {
  extId: string;
  // §1 #12:interpret 透傳原始 adminPage.title(LocalizedString);此 server view resolve。
  title: LocalizedString;
  adminSlug: string;
  contentType: DeclarativeContentType;
  entryId?: string;
}

export async function FormViewPage({
  extId,
  title,
  adminSlug,
  contentType,
  entryId,
}: FormViewPageProps) {
  const locale = await getLocale();
  const m = getMessages(locale);
  const resolvedTitle = resolveLocalizedString(title, locale) ?? contentType.name;
  const def = toTypeDef(extId, contentType);
  const base = `/admin/ext/${extId}${adminSlug ? `/${adminSlug}` : ""}`;

  let initialData: Record<string, unknown> = {};
  let initialStatus: "draft" | "published" = "draft";
  let initialPublishAt: number | null = null;
  // 版本紀錄在 server 就查好(client 不再為了首屏打一次自己的 API)。歷史表讀不到
  // (0010 migration 尚未套用)時退回空陣列 —— 編輯頁本身絕不能因為附屬面板而 500。
  let revisions: RevisionRowDTO[] = [];
  if (entryId) {
    const provider = await getContentProvider();
    const existing = await provider.get(def.type, entryId);
    if (existing) {
      initialData = existing.data;
      initialStatus = existing.status;
      // publishAt 為 row 欄位,不在 ContentEntry 上(見 content-provider.ts)。
      initialPublishAt = await getContentPublishAt(entryId);
      try {
        revisions = await listRevisions(entryId);
      } catch (e) {
        console.error("[dx:form] revision history unavailable", entryId, e);
      }
    }
  }

  // 編輯頁標題:ap.title 是 nav/collection 用的複數 label(如 "Posts"),直接接
  // `Edit ${title}` 在單筆編輯頁會變成「Edit Posts」這種單複數不一致的字眼。
  // 改用該筆 entry 自己的標題欄(復用 grid 卡片同一套 inferCardConfig 推斷,
  // 對所有 declarative type 一致,無需額外設定);拿不到值(新建 entry 或該欄
  // 為空)才回退到原本的 `Edit ${title}`。
  const card = inferCardConfig(contentType.fields, contentType.slugField);
  const entryTitleRaw = card.titleKey ? initialData[card.titleKey] : undefined;
  const entryTitle =
    typeof entryTitleRaw === "string" && entryTitleRaw.trim().length > 0
      ? entryTitleRaw
      : undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageTitle>
        {entryId
          ? entryTitle
            ? format(m["extForm.admin.editEntry"], { title: entryTitle })
            : format(m["extForm.admin.editType"], { type: resolvedTitle })
          : format(m["collection.new"], { type: resolvedTitle })}
      </PageTitle>
      <AdminFormSurface
        extId={extId}
        typeName={contentType.name}
        fields={contentType.fields}
        slugField={contentType.slugField}
        backHref={base}
        initialId={entryId}
        initialData={initialData}
        initialStatus={initialStatus}
        initialPublishAt={initialPublishAt}
        contentType={contentType}
        locale={locale}
      />
      {/* 版本紀錄只在編輯既有 entry 時出現(新建頁沒有 id,自然沒有歷史)。放在表單
          之後、留出下緣間距,避免被 FormView 那條 fixed 底部儲存列蓋住。 */}
      {entryId && (
        <div className="max-w-3xl pt-2 pb-28">
          <RevisionHistory
            extId={extId}
            typeName={contentType.name}
            entryId={entryId}
            revisions={revisions}
            now={requestTimestamp()}
          />
        </div>
      )}
    </div>
  );
}
