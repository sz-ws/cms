import { CORE_API_VERSION } from "../version";
import { satisfies } from "../semver";
import { parseManifest } from "./manifest";
import type {
  DeclarativeContentType,
  DeclarativeManifest,
  DeclarativePublicRoute,
} from "./manifest";
import { toSettingField } from "./setting-field";
import type {
  AdminPage,
  Extension,
  HookName,
  PublicRoute,
} from "../types";
import { CollectionView } from "./views/CollectionView";
import type { CollectionViewProps } from "./views/CollectionView";
import { InboxView } from "./views/InboxView";
import type { InboxViewProps } from "./views/InboxView";
import { FormViewPage } from "./views/FormViewPage";
import type { FormViewPageProps } from "./views/FormViewPage";
import { FormView } from "./views/FormView";
import { ListView } from "./views/ListView";
import type { ListViewProps } from "./views/ListView";
import { DetailView } from "./views/DetailView";
import type { DetailViewProps } from "./views/DetailView";
import { ExtThemeScope } from "./theme-scope";
import { buildCrudRoutes } from "./crud";
import { compilePattern, matchSegments } from "./route-matcher";
import { makeWebhookHandler } from "./webhook";
import { surfaceIds } from "./surfaces";
import { overrideRegistry } from "../overrides";
import { buildScheduleJobs } from "./schedule-jobs";
import { allowedPublicRoutes, submissionTypeNames } from "./submission";
import { getLocale } from "@/lib/i18n/server";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import type { ComponentType } from "react";

// core-v2 §3.3:interpreter。把儲存的 declarative manifest 列轉為 loader 已消費的
// Extension 形狀。install 與 interpret 兩端都重新 parseManifest(§5 防禦手改 DB)。
//
// core-v2 §3.6:progressive override。為每個 surface 產生元件前,先查 overrideRegistry
// —— 有登記(僅在 code 強化層 build 進 bundle 時存在)→ 用自訂元件;無 → 泛用 baseline。
// resolveSurface() 封裝這個「override-else-baseline」選擇,並保持型別安全:override 元件
// 收到與泛用 view 完全相同的 props(§3.6 契約)。
//
// 決策(manifest hint):v1 的解析純看「是否登記了 override」,不 gate 於任何 manifest 旗標。
// 這與 §3.6「baseline is the fallback / a registered override wins」一致,且讓 code 層
// 無需先改 manifest 即可覆寫。manifest 端的 overridableSurfaces hint(文件/意圖)留待需要時
// 再加,不作為 v1 解析條件(spec §3.6 允許此取捨:permissive)。

/**
 * 為某 surface 選出實際渲染元件:overrideRegistry.get(extId, surfaceId) ?? generic。
 * generic 泛型參數 P = 該 surface 的 props;override 元件被登記時已保證同 props,故此處
 * 收斂回 ComponentType<P> 不放寬約束(見 overrides.ts register 的 view-key 綁定)。
 */
function resolveSurface<P>(
  extId: string,
  surfaceId: string,
  generic: ComponentType<P>,
): ComponentType<P> {
  const override = overrideRegistry.get(extId, surfaceId);
  return override
    ? (override as unknown as ComponentType<P>)
    : generic;
}

export interface DeclarativeRow {
  id: string;
  manifest: string; // JSON 字串
  version: string;
  enabled: number;
}

/** local content type name → def(供 view/route 查找)。 */
function typeByName(
  manifest: DeclarativeManifest,
): Map<string, DeclarativeContentType> {
  const m = new Map<string, DeclarativeContentType>();
  for (const ct of manifest.contentTypes ?? []) m.set(ct.name, ct);
  return m;
}

// ---- admin pages(collection + edit form)----

function buildAdminPages(
  extId: string,
  manifest: DeclarativeManifest,
  types: Map<string, DeclarativeContentType>,
  submissions: Set<string>,
): AdminPage[] {
  const pages: AdminPage[] = [];
  for (const ap of manifest.adminPages ?? []) {
    const ct = types.get(ap.contentType);
    if (!ct) continue; // 指向不存在的 type:跳過(schema 不強制交叉檢查)。
    const slug = ap.slug;
    const editSlug = slug ? `${slug}/edit` : "edit";
    const contentType = `${extId}.${ct.name}`; // 完整 type key(surface 鍵)

    // 收件匣型別:換成 InboxView,且**不**產生 edit 頁 —— 別人寄來的訊息沒有
    // 「編輯」這個動作(CRUD 的 PUT 也已收窄成 403,見 dx/crud.ts)。
    // collection surface 的 override 機制對它一樣有效:同一個 surface id,
    // 登記了就用登記的,沒登記才用這個 baseline。
    if (submissions.has(ct.name)) {
      const Inbox = resolveSurface<InboxViewProps>(
        extId,
        surfaceIds.adminCollection(contentType),
        InboxView,
      );
      pages.push({
        slug,
        title: ap.title,
        component: ({ searchParams }) => (
          <Inbox
            extId={extId}
            title={ap.title}
            adminSlug={slug}
            contentType={ct}
            searchParams={searchParams}
          />
        ),
      });
      continue;
    }

    // §3.6:collection surface —— override(admin:<type>:collection)或泛用 baseline。
    const Collection = resolveSurface<CollectionViewProps>(
      extId,
      surfaceIds.adminCollection(contentType),
      CollectionView,
    );
    // collection 頁。分頁·排序·filter state 由 searchParams 帶入。
    pages.push({
      slug,
      title: ap.title,
      component: ({ searchParams }) => (
        <Collection
          extId={extId}
          title={ap.title}
          adminSlug={slug}
          contentType={ct}
          searchParams={searchParams}
          layout={ap.layout} // §3.5 缺省 → table(view 內處理)
        />
      ),
    });
    // §3.6:form surface —— override(admin:<type>:form)或泛用 baseline。
    const Form = resolveSurface<FormViewPageProps>(
      extId,
      surfaceIds.adminForm(contentType),
      FormViewPage,
    );
    // edit / new 頁(不進 menu)。title 保留原始 LocalizedString(memo-safe);此頁
    // showInMenu:false 且 admin ext route 只用 component、不顯示 title,故不再拼
    // `${title} — Edit`(拼 LocalizedString 物件會壞)——實際編輯頁標題由 FormViewPage
    // 以其 title prop + getLocale() resolve 後渲染。
    pages.push({
      slug: editSlug,
      title: ap.title,
      showInMenu: false,
      component: ({ searchParams }) => (
        <Form
          extId={extId}
          title={ap.title}
          adminSlug={slug}
          contentType={ct}
          entryId={searchParams.id || undefined}
        />
      ),
    });
  }
  return pages;
}

// ---- public form body(spec §1 #3/#14:public 頁無 I18nProvider,故 title / success
// message 必須 server-side resolve 後再往下傳)----
// 這是一個 async server component:每 request 以 getLocale() resolve(memo-safe —— ct /
// success 是 interpret 期凍結的原始資料,locale 於此每 request 讀取,不觸 loader memo)。
// 同時把 locale 傳給 FormView,供其 field label / ExtLocaleProvider 使用。
async function PublicFormBody({
  extId,
  ct,
  theme,
  success,
  stepped,
}: {
  extId: string;
  ct: DeclarativeContentType;
  theme: DeclarativeManifest["theme"];
  success: DeclarativePublicRoute["success"];
  stepped: boolean | undefined;
}) {
  const locale = await getLocale();
  return (
    <ExtThemeScope extId={extId} theme={theme}>
      <FormView
        mode="public"
        extId={extId}
        typeName={ct.name}
        title={resolveLocalizedString(ct.label, locale) ?? ct.name}
        fields={ct.fields}
        slugField={ct.slugField}
        successMessage={resolveLocalizedString(success?.message, locale)}
        stepped={stepped} // 1.7.0:≥4 個公開可渲染欄位 + stepped:true → Stepper 多步
        locale={locale}
      />
    </ExtThemeScope>
  );
}

// ---- public routes ----

function buildPublicRoutes(
  extId: string,
  manifest: DeclarativeManifest,
  types: Map<string, DeclarativeContentType>,
): PublicRoute[] {
  const routes: PublicRoute[] = [];
  // 隱私硬需求:收件匣型別**永遠**不生成公開可讀路由。判定與過濾住在純模組
  // (dx/submission.ts),因為這是本功能最重要的正確性需求,必須能被測試直接斷言 ——
  // 而本檔經 views 拉進 next/navigation 等相依,在 workers pool 測試環境載不起來
  // (同 schedule-jobs.ts / dashboard-cards.ts 的既有決策)。
  const byType = allowedPublicRoutes(
    manifest,
    manifest.publicRoutes ?? [],
    (route) =>
      console.error(
        `[dx:interpret] ext=${extId} refused public "${route.view}" route for submission type "${route.contentType}"`,
      ),
  );
  // 1.8.0:manifest.theme(若有)包住每個 public view,注入 --ext-* CSS 變數。admin 無視。
  const theme = manifest.theme;

  // 為 detail link 找同 contentType 的 detail route 前綴(去掉尾端 :param 段)。
  const detailBaseFor = (contentType: string): string | null => {
    const detail = byType.find(
      (r: DeclarativePublicRoute) =>
        r.contentType === contentType && r.view === "detail",
    );
    if (!detail) return null;
    const parts = detail.pattern.split("/").filter((s) => s.length > 0);
    parts.pop(); // 去掉 :slug 段
    return `/${parts.join("/")}`;
  };

  for (const pr of byType) {
    const ct = types.get(pr.contentType);
    if (!ct) continue;
    const template = compilePattern(pr.pattern);
    const contentType = `${extId}.${ct.name}`; // 完整 type key(surface 鍵)

    if (pr.view === "list") {
      const detailBase = detailBaseFor(pr.contentType);
      // §3.6:list surface —— override(public:<type>:list)或泛用 baseline。
      const List = resolveSurface<ListViewProps>(
        extId,
        surfaceIds.publicList(contentType),
        ListView,
      );
      routes.push({
        match: (segments) => matchSegments(template, segments),
        component: () => (
          <ExtThemeScope extId={extId} theme={theme}>
            <List
              extId={extId}
              contentType={ct}
              detailBase={detailBase}
              layout={pr.layout} // §3.5 缺省 → table(view 內處理)
            />
          </ExtThemeScope>
        ),
      });
    } else if (pr.view === "form") {
      // 公開表單現在直接共用泛用 FormView,不再維護一個 public-only thin shell。
      // public:true 仍由 dispatch(/api/ext/...) 控制匿名 POST 權限。title / success
      // message 的 locale resolve 移進 async PublicFormBody(public 頁無 provider)。
      const success = pr.success;
      const stepped = pr.stepped;
      routes.push({
        match: (segments) => matchSegments(template, segments),
        component: () => (
          <PublicFormBody
            extId={extId}
            ct={ct}
            theme={theme}
            success={success}
            stepped={stepped}
          />
        ),
      });
    } else {
      // §3.6:detail surface —— override(public:<type>:detail)或泛用 baseline。
      const Detail = resolveSurface<DetailViewProps>(
        extId,
        surfaceIds.publicDetail(contentType),
        DetailView,
      );
      routes.push({
        match: (segments) => matchSegments(template, segments),
        component: ({ params }) => (
          <ExtThemeScope extId={extId} theme={theme}>
            <Detail
              extId={extId}
              contentType={ct}
              slug={params.slug ?? ""}
            />
          </ExtThemeScope>
        ),
      });
    }
  }
  return routes;
}

// ---- api routes ----

function buildApiRoutes(
  extId: string,
  manifest: DeclarativeManifest,
  submissions: Set<string>,
) {
  return (manifest.contentTypes ?? []).flatMap((ct) =>
    buildCrudRoutes(extId, ct, submissions.has(ct.name)),
  );
}

// ---- hooks(on bindings)----

function buildHooks(
  extId: string,
  manifest: DeclarativeManifest,
): Partial<Record<HookName, ReturnType<typeof makeWebhookHandler>>> {
  const hooks: Partial<Record<string, ReturnType<typeof makeWebhookHandler>>> =
    {};
  for (const [hookName, actions] of Object.entries(manifest.on ?? {})) {
    if (!actions || actions.length === 0) continue;
    hooks[hookName] = makeWebhookHandler(extId, hookName, actions);
  }
  return hooks as Partial<
    Record<HookName, ReturnType<typeof makeWebhookHandler>>
  >;
}

// ---- forms 引擎已撤(declarative 化後,forms/contact 直接走 contentType submission)----
// 過去這裡有 buildForms():為每個 declarative form 產生 admin submissions page + public
// form page。現在 declarative content type(配合 public:true 旗標)走 auto-CRUD + 現成
// CollectionView,不需要 form engine。PublicFormView 改在 collection admin 派發後,本檔
// 已不需要任何 form 路由生成。


/**
 * 把一列 declarative_extensions 轉為 Extension。manifest 於此重新 parseManifest;
 * 無效 → 回傳 null(loader 跳過並 log,絕不 crash;§5)。
 */
export function interpretManifest(row: DeclarativeRow): Extension | null {
  let json: unknown;
  try {
    json = JSON.parse(row.manifest);
  } catch {
    console.error(`[dx:interpret] ext=${row.id} manifest not valid JSON`);
    return null;
  }
  const parsed = parseManifest(json);
  if (!parsed.ok || !parsed.manifest) {
    console.error(`[dx:interpret] ext=${row.id} invalid manifest: ${parsed.error}`);
    return null;
  }
  const manifest = parsed.manifest;
  const types = typeByName(manifest);
  // 1.21.0:哪些 content type 是收件匣。判定一次、往下傳給三個 surface builder,
  // 確保 admin / public / API 三邊對「這是不是私人訊息」的認知不可能分叉。
  const submissions = submissionTypeNames(manifest);

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    coreApi: manifest.coreApi,
    description: manifest.description,
    icon: manifest.icon,
    og: manifest.og,
    settings: (manifest.settings ?? []).map(toSettingField),
    adminPages: buildAdminPages(manifest.id, manifest, types, submissions),
    apiRoutes: buildApiRoutes(manifest.id, manifest, submissions),
    publicRoutes: buildPublicRoutes(manifest.id, manifest, types),
    hooks: buildHooks(manifest.id, manifest),
    // Alpha:讓 dispatch 識別 public type(POST 跳 requireAuth)。
    contentTypes: manifest.contentTypes,
    // roadmap #16:dashboard 卡直接透傳(同 contentTypes;實際查詢與渲染交給
    // dashboard-cards.ts + 卡片元件)。
    dashboardCards: manifest.dashboardCards,
    // B(docs/spec-declarative-notify-schedule.md):manifest.schedule[] → jobs,
    // 騎在 ext-jobs 引擎上(src/lib/jobs.ts 既有 reconcile/claim/執行,零引擎改動)。
    jobs: buildScheduleJobs(manifest.id, manifest, types),
  };
}

/** manifest 的 coreApi 是否相容目前 CORE_API_VERSION。 */
export function isManifestCompatible(manifest: DeclarativeManifest): boolean {
  return satisfies(CORE_API_VERSION, manifest.coreApi);
}
