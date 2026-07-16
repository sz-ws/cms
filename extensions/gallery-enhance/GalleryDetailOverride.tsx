import { notFound } from "next/navigation";
import { getContentProvider, toTypeDef } from "@/ext/dx/runtime";
import { displayValue, fieldLabel } from "@/ext/dx/views/field-utils";
import type { DetailSurfaceProps } from "@/ext/overrides";
import { getLocale } from "@/lib/i18n/server";

// core-v2 §3.6 DEMO ONLY —— progressive extension 的「程式碼強化層」示範。
//
// 這是 seeded 宣告式 `gallery` extension 的 public detail surface
// (surfaceId "public:gallery.item:detail")的自訂覆寫元件。它:
//   - 收到與泛用 DetailView 完全相同的 props(DetailSurfaceProps = DetailViewProps),
//   - 走同一個 content provider 讀「同一份資料」(baseline 擁有資料;override 只換呈現),
//   - 渲染一個視覺上明顯不同的版面:頂部彩色 banner + 大圖 hero + 欄位卡片。
//
// 證明流程:
//   (a) 此 override 經 extensions/registry.ts 的 side-effect import 登記後,載入 /gallery/<slug>
//       → 顯示此自訂版面(頂部漸層色帶 + hero 圖 + 卡片欄位,泛用 baseline 沒有這些)。
//   (b) 概念上移除登記(註解掉 registry.ts 內那行 import,或 registerGalleryEnhancements 內
//       那次 register)→ interpret.tsx 的 resolveSurface 找不到 override → 退回泛用 DetailView
//       baseline,同一份資料照樣渲染(zero data loss / zero behavior change)。
//
// 註:僅覆寫 detail;同 type 的 collection/list/form 三個 surface 仍走泛用 baseline
// —— 這正是 §3.6「per-surface 覆寫、baseline 永遠是後備」的直接體現。

export async function GalleryDetailOverride({
  extId,
  contentType,
  slug,
}: DetailSurfaceProps) {
  const locale = await getLocale();
  const def = toTypeDef(extId, contentType);
  const provider = await getContentProvider();
  const entry = await provider.getBySlug(def.type, slug);
  if (!entry || entry.status !== "published") notFound();

  const titleField =
    contentType.fields.find((f) => f.key === contentType.slugField) ??
    contentType.fields[0];
  const title =
    displayValue(titleField, entry.data[titleField.key]) || entry.id;

  // 第一個 media 欄位作 hero 圖(baseline 只列成 dl 內小圖;這裡放大成 hero)。
  const mediaField = contentType.fields.find((f) => f.type === "media");
  const mediaKey =
    mediaField && typeof entry.data[mediaField.key] === "string"
      ? (entry.data[mediaField.key] as string)
      : null;

  // 其餘可顯示欄位(排除 media,已當 hero)。
  const detailFields = contentType.fields.filter(
    (f) => f.type !== "media" && f.type !== "richtext",
  );

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
      {/* DEMO accent bar —— 泛用 baseline 沒有此塊,是最直觀的「override 生效」
          視覺標記。文案刻意留白:這是內部驗收用的 demo 元件,不對訪客暴露
          spec 章節號或「progressive override」之類的開發行話(見本檔頂部
          檔案註解)。單純的漸層色帶已足夠讓兩種呈現方式一眼可辨。 */}
      <div
        data-testid="gallery-enhance-banner"
        aria-hidden="true"
        className="h-2 w-full rounded-full bg-gradient-to-r from-indigo-600 to-fuchsia-600 shadow-lg"
      />
      <span className="sr-only">Featured gallery item</span>

      {mediaKey && (
        // eslint-disable-next-line @next/next/no-img-element -- media 為任意 storage key;v1 用原生 img(同 baseline DetailView)。
        <img
          src={`/api/files/${mediaKey}`}
          alt={title}
          className="w-full rounded-2xl object-cover shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)]"
        />
      )}

      <h1 className="text-4xl font-bold tracking-tight text-gray-900">
        {title}
      </h1>

      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {detailFields.map((f) => {
          const value = entry.data[f.key];
          if (value === undefined || value === null || value === "") return null;
          return (
            <div
              key={f.key}
              className="flex flex-col gap-1 rounded-xl border border-black/[0.06] bg-white p-4 shadow-sm"
            >
              <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">
                {fieldLabel(f, locale)}
              </dt>
              <dd className="text-base text-gray-800">{displayValue(f, value)}</dd>
            </div>
          );
        })}
      </dl>
    </main>
  );
}
