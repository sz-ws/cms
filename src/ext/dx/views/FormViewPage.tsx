import { PageTitle } from "@/components/ui/legacy";
import { getContentProvider, toTypeDef } from "../runtime";
import { getContentPublishAt } from "../content-provider";
import type { DeclarativeContentType } from "../manifest";
import { AdminFormSurface } from "./AdminFormSurface";
import { inferCardConfig } from "./collection/card-config";

// admin create/edit 頁(server component)。edit 模式(?id=…)先載入既有 entry,
// 再交給 client surface。Surface 先嘗試固定入口 layout.tsx 註冊的元件,
// 沒有就用 generic FormView(走 contentType.layout 的 auto2col/single/manual)。

export interface FormViewPageProps {
  extId: string;
  title: string;
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
  const def = toTypeDef(extId, contentType);
  const base = `/admin/ext/${extId}${adminSlug ? `/${adminSlug}` : ""}`;

  let initialData: Record<string, unknown> = {};
  let initialStatus: "draft" | "published" = "draft";
  let initialPublishAt: number | null = null;
  if (entryId) {
    const provider = await getContentProvider();
    const existing = await provider.get(def.type, entryId);
    if (existing) {
      initialData = existing.data;
      initialStatus = existing.status;
      // publishAt 為 row 欄位,不在 ContentEntry 上(見 content-provider.ts)。
      initialPublishAt = await getContentPublishAt(entryId);
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
            ? `Edit: ${entryTitle}`
            : `Edit ${title}`
          : `New ${title}`}
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
      />
    </div>
  );
}
