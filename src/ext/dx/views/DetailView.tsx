import { notFound } from "next/navigation";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { toTypeDef } from "../runtime";
import { cachedPublicGetBySlug } from "../content-cache";
import type { DeclarativeContentType, DeclarativeField } from "../manifest";
import { displayValue, fieldLabel } from "./field-utils";
import { renderRichtext } from "./richtext-render";
import { renderStructural } from "./structural-render";
import { getLocale } from "@/lib/i18n/server";
import { resolveRelations, type ResolvedRelation } from "../relation-resolve";
import { isMediaKey } from "../media-key";
import { collectMediaKeys, loadMediaDims } from "./media-dims";
import { MediaImage } from "@/components/ui/media-image";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";

const STRUCTURAL_TYPES = new Set<DeclarativeField["type"]>([
  "group",
  "repeater",
  "blocks",
]);

// core-v2 §3.3:generic public detail view。依 slug 查 published entry,
// 依 field def 順序 render 各欄位。最小語意 HTML。

export interface DetailViewProps {
  extId: string;
  contentType: DeclarativeContentType;
  slug: string;
}

/** 從 data 值取出 relation/relations 的 id 陣列(單一 → [id],多 → ids)。 */
function relationIds(field: DeclarativeField, value: unknown): string[] {
  if (field.type === "relation") {
    return typeof value === "string" && value.length > 0 ? [value] : [];
  }
  if (field.type === "relations" && Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.length > 0);
  }
  return [];
}

export async function DetailView({
  extId,
  contentType,
  slug,
}: DetailViewProps) {
  const locale = await getLocale();
  const def = toTypeDef(extId, contentType);
  // public 匿名讀取:走 tagged data cache(content:<type> / ext:<extId>),mutation 精準失效。
  const entry = await cachedPublicGetBySlug(extId, def.type, slug);
  if (!entry || entry.status !== "published") notFound();

  const titleField =
    contentType.fields.find((f) => f.key === contentType.slugField) ??
    contentType.fields[0];
  const title =
    displayValue(titleField, entry.data[titleField.key]) || entry.id;

  // 08 §2:先解析所有 relation/relations 欄位的 id → { title, href }(server-side,
  // 走 provider 直查,無 HTTP)。逐欄位一組,供下方同步 map 顯示。
  const relations = new Map<string, ResolvedRelation[]>();
  await Promise.all(
    contentType.fields.map(async (f) => {
      if (f.type !== "relation" && f.type !== "relations") return;
      if (!f.to) return;
      const ids = relationIds(f, entry.data[f.key]);
      if (ids.length === 0) return;
      relations.set(f.key, await resolveRelations(f.to, ids));
    }),
  );

  // 圖片原生尺寸:一次收齊本頁所有 media key(頂層 + 巢狀),平行問 R2 metadata,
  // 讓 <img> 寫得出 width/height(免 CLS)。查不到的 key 就只是少了那兩個屬性。
  const mediaDims = await loadMediaDims(
    collectMediaKeys(contentType.fields, entry.data),
  );

  // 公開頁清理:`author` 欄存的是內部 user id(如 "Ccjf9UDqD8OXASUmvP_0H"),對
  // 訪客毫無意義且外洩內部識別碼。查 users 表換成可讀名字;查無該 user 時整欄
  // 不渲染(寧可不顯示也不洩內部 ID)。單次直查(公開頁已走 tagged content cache,
  // 這一小查詢可接受;不引入新的 cache 機制)。
  const authorRaw = entry.data["author"];
  let authorName: string | null = null;
  if (typeof authorRaw === "string" && authorRaw.length > 0) {
    const rows = await db()
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, authorRaw))
      .limit(1);
    authorName = rows[0]?.name ?? null;
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      <h1 className="text-3xl font-semibold text-gray-900">{title}</h1>
      <dl className="flex flex-col gap-4">
        {contentType.fields.map((f) => {
          // h1 已顯示過標題欄,dl 內不重複。
          if (f.key === titleField.key) return null;
          // slug 只是路由用的技術性欄位,對訪客無意義。
          if (f.type === "slug") return null;
          const value = entry.data[f.key];
          if (value === undefined || value === null || value === "") return null;
          // author:只顯示解析出的使用者名稱;查無 user → 整欄不渲染(見上方
          // authorName 解析,不落地內部 user id)。
          if (f.key === "author") {
            if (!authorName) return null;
            return (
              <div key={f.key} className="flex flex-col gap-1">
                <dt className="text-sm font-medium text-gray-500">
                  {fieldLabel(f, locale)}
                </dt>
                <dd className="text-base text-gray-800">{authorName}</dd>
              </div>
            );
          }
          return (
            <div key={f.key} className="flex flex-col gap-1">
              <dt className="text-sm font-medium text-gray-500">
                {fieldLabel(f, locale)}
              </dt>
              <dd className="text-base text-gray-800">
                {f.type === "richtext" ? (
                  // C.5b §3: safe React-element render of Tiptap JSON (no
                  // dangerouslySetInnerHTML). prose spacing via child styles.
                  <div className="richtext-content flex flex-col gap-3 [&_a]:text-indigo-600 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-gray-200 [&_blockquote]:pl-4 [&_blockquote]:text-gray-600 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:text-lg [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6">
                    {renderRichtext(value)}
                  </div>
                ) : f.type === "media" ? (
                  // Phase E §2: render-time allowlist guard mirroring
                  // richtext-render's image src check — a stored value that
                  // doesn't pass isMediaKey (hand-edited row, legacy bad
                  // data) renders nothing rather than an unsafe <img src>.
                  isMediaKey(String(value)) ? (
                    // 版心 max-w-2xl(672px)扣掉 px-6:實際版位 ≤ 624px,srcset
                    // 上限給 640 這一格就夠,不必列到 1920w。
                    <MediaImage
                      mediaKey={String(value)}
                      alt={title}
                      maxWidth={640}
                      sizes="(max-width: 672px) 100vw, 640px"
                      width={mediaDims.get(String(value))?.width}
                      height={mediaDims.get(String(value))?.height}
                      className="max-w-full rounded"
                    />
                  ) : null
                ) : f.type === "relation" || f.type === "relations" ? (
                  // 08 §2: resolved id → title, linked when the target has a
                  // public detail route + is published.
                  <span className="flex flex-wrap items-center gap-2">
                    {(relations.get(f.key) ?? []).map((r) =>
                      r.href ? (
                        <Link
                          key={r.id}
                          href={r.href}
                          // 1.8.0:accent token tint(fallback 為現行 indigo-600)。
                          style={{ color: "var(--ext-accent, #4f46e5)" }}
                          className="underline"
                        >
                          {r.title}
                        </Link>
                      ) : (
                        <span key={r.id}>{r.title}</span>
                      ),
                    )}
                  </span>
                ) : STRUCTURAL_TYPES.has(f.type) ? (
                  // Tier 2 v1.2: group/repeater/blocks → readable nested render.
                  renderStructural(f, value, locale, mediaDims)
                ) : (
                  displayValue(f, value)
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </main>
  );
}
