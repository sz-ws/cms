import { z } from "zod";
import { validateSvg } from "./svg-guard";
import type { LocalizedString } from "@/lib/i18n/localized";

// core-v2 §3.2:declarative manifest v1 的 zod schema。
// 為 registry/schema/manifest.schema.json 的權威對應版本(spec §5:install 與 interpret
// 兩端都以此重新驗證,防範手改 DB 列)。所有 object 一律 .strict()
// (對應 JSON Schema 的 additionalProperties:false)。

// ---- 基礎規則(與 JSON Schema pattern 一字對應)----

const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const CORE_API_RE = /^(\^|~|>=)?\d+\.\d+\.\d+$/;
const TYPE_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
const FIELD_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
// route pattern:純 segment 字串,允許字面段 /foo 或 param 段 /:name,無 regex 特殊字元。
const ROUTE_PATTERN_RE = /^(\/[a-z0-9-]+|\/:[a-zA-Z][a-zA-Z0-9]*)+$/;
// 08 §2:relation `to` 目標,形狀 "<extId>.<typeName>"(同 ContentTypeDef.type key)。
// extId 段套 ID_RE 的長度界(1..31),typeName 段套 TYPE_NAME_RE(0..31 尾字)。
// 純字面,無 regex 特殊字元;install 與 interpret 兩端皆驗。
const RELATION_TO_RE = /^[a-z][a-z0-9-]{1,30}\.[a-z][a-z0-9-]{0,30}$/;

// ---- LocalizedString(spec-extension-i18n.md,Option A:inline per-locale union)----
// 使用者可見字串站點的形狀:plain string(現況、無語言意識)或 per-locale 物件。
// localizedObjectSchema 是 .strict()(對應 JSON Schema additionalProperties:false)
// 且 refine「至少一鍵」—— 空物件 `{}` 無意義,拒之。canonical locale token 為
// `en` / `zh-Hant`(src/lib/i18n/index.ts Locale;注意大小寫是 `zh-Hant`)。
//
// localized(base?) 產生 union:第一分支保留呼叫端指定的「原本 string schema」
// (保留 min/max 等既有約束 → 純字串 manifest 一字不改全過),第二分支是物件形式。
// gen-manifest-schema.mts 會把重複的 object 分支 factor 成一個 $defs/localizedString。
const localizedObjectSchema = z
  .object({
    en: z.string().optional(),
    "zh-Hant": z.string().optional(),
  })
  .strict()
  .refine((v) => v.en !== undefined || v["zh-Hant"] !== undefined, {
    message: "localized string requires at least one locale (en / zh-Hant)",
  });

function localized(base: z.ZodString = z.string()) {
  return z.union([base, localizedObjectSchema]);
}

// ---- leaf field types(v1.1 + 08 §1)----
// core-v2 §3.2 的「單值」欄位。可作為 top-level 欄位,也可作為 Tier 2 結構欄位
// (group/repeater/blocks)的 nested 子欄位。結構欄位「不」屬於 leaf(見下)。
export const LEAF_FIELD_TYPES = [
  "text",
  "richtext",
  "number",
  "boolean",
  "date",
  "media",
  "select",
  "slug",
  "json",
  // 08 §1:content-to-content 關聯。relation = 單一 entryId 字串;
  // relations = 有序 entryId 字串陣列。兩者 manifest 皆須 `to: "<extId>.<typeName>"`。
  "relation",
  "relations",
] as const;

// ---- structural field types(Tier 2 v1.2:core-v2 §3.2 + dx-field-components.md)----
// group   = nested fieldset       → value { …subfield values }
// repeater= sortable list of groups→ value [{ … }, …](有序)
// blocks  = block-type chooser    → value [{ block: "<name>", …fields }, …](有序)
export const STRUCTURAL_FIELD_TYPES = ["group", "repeater", "blocks"] as const;

// FIELD_TYPES = 全部可宣告的 top-level 欄位型別(leaf + structural)。
export const FIELD_TYPES = [
  ...LEAF_FIELD_TYPES,
  ...STRUCTURAL_FIELD_TYPES,
] as const;

// 需要 `to` 的 field type;其餘 type 禁止帶 `to`(strict + refine)。
const RELATION_TYPES = new Set<(typeof LEAF_FIELD_TYPES)[number]>([
  "relation",
  "relations",
]);

// ---- leaf field ----
// leaf refine(select 需 options、relation/relations 需 to、其餘禁 to)。top-level
// leaf 欄位與 nested(group/repeater/blocks 的子欄位)共用同一個 leafFieldSchema。

const leafFieldSchema = z
  .object({
    key: z.string().regex(FIELD_KEY_RE, "invalid field key"),
    type: z.enum(LEAF_FIELD_TYPES),
    label: localized().optional(),
    required: z.boolean().optional(),
    // select 專用;JSON Schema 要求 minItems:1。
    // i18n note(spec §3.4):`options` 的字串同時是「儲存值」與「顯示 label」,就地
    // localize 會破壞儲存值 —— 需把 string[] 升成 {value,label} 的較大工程,v1 刻意
    // 不做(列 follow-up)。故此站點維持 plain string[](非 LocalizedString)。
    options: z.array(z.string()).min(1).optional(),
    // 08 §2:relation/relations 專用;目標 content type 的完整 key。
    to: z.string().regex(RELATION_TO_RE, "invalid relation target (expect <extId>.<typeName>)").optional(),
    // text 欄位:宣告 multiline 可把 input 升級為可放大寫作的 textarea。
    // (richer writing → TextFullscreenEditor overlay,Esc 收。)
    multiline: z.boolean().optional(),
  })
  .strict()
  .refine((f) => f.type !== "select" || (f.options?.length ?? 0) >= 1, {
    message: "select field requires non-empty options",
    path: ["options"],
  })
  .refine((f) => !RELATION_TYPES.has(f.type) || typeof f.to === "string", {
    message: "relation/relations field requires `to`",
    path: ["to"],
  })
  .refine((f) => RELATION_TYPES.has(f.type) || f.to === undefined, {
    message: "`to` is only valid on relation/relations fields",
    path: ["to"],
  })
  .refine((f) => f.multiline === undefined || f.type === "text", {
    message: "`multiline` is only valid on text fields",
    path: ["multiline"],
  });

// leaf 子欄位陣列(group/repeater/blocks 的 nested fields)。v1 限制:只允許 leaf
// 型別 —— 結構欄位「不可」再嵌結構欄位(一層 nesting 上限,見 core-v2 §3.2 v1 note)。
const leafFieldsSchema = z.array(leafFieldSchema).min(1);

// ---- structural fields(Tier 2 v1.2)----
// z.lazy 非必要(v1 只一層 nesting,fields 一律 leaf),但仍用明確的 leaf-bound
// 陣列,把「不可再嵌結構欄位」這條規則寫進 schema 本身(而非只在 UI/validation 靠
// 慣例維持)。JSON Schema 端以 #/$defs/leafField 對應此界。

const groupFieldSchema = z
  .object({
    key: z.string().regex(FIELD_KEY_RE, "invalid field key"),
    type: z.literal("group"),
    label: localized().optional(),
    required: z.boolean().optional(),
    fields: leafFieldsSchema, // nested leaf 子欄位(≥1)
  })
  .strict();

const repeaterFieldSchema = z
  .object({
    key: z.string().regex(FIELD_KEY_RE, "invalid field key"),
    type: z.literal("repeater"),
    label: localized().optional(),
    required: z.boolean().optional(),
    fields: leafFieldsSchema, // 每個 row 的 leaf 子欄位(≥1)
    max: z.number().int().positive().optional(), // 可選:row 數上限
  })
  .strict();

const blockDefSchema = z
  .object({
    name: z.string().regex(TYPE_NAME_RE, "invalid block name"),
    label: localized().optional(),
    fields: leafFieldsSchema, // 該 block 的 leaf 子欄位(≥1)
  })
  .strict();

const blocksFieldSchema = z
  .object({
    key: z.string().regex(FIELD_KEY_RE, "invalid field key"),
    type: z.literal("blocks"),
    label: localized().optional(),
    required: z.boolean().optional(),
    blocks: z.array(blockDefSchema).min(1), // 宣告的具名 block 形狀(≥1)
    max: z.number().int().positive().optional(), // 可選:block 數上限
  })
  .strict();

// ---- field(top-level:leaf | structural)----
// discriminated-ish union:top-level 欄位可為任一 leaf 型別或任一結構型別。
// leaf refine 已內建於 leafFieldSchema;結構 schema 自帶 nested 界。
const fieldSchema = z.union([
  leafFieldSchema,
  groupFieldSchema,
  repeaterFieldSchema,
  blocksFieldSchema,
]);

const formLayoutColumnSchema = z
  .object({
    fields: z.array(z.string().min(1)).min(1),
    fullWidth: z.boolean().optional(),
  })
  .strict();

const formLayoutSchema = z
  .object({
    // "auto2col" = declarative baseline (full-row tall fields, paired short fields).
    // "single"   = single column stack.
    // "manual"   = author-defined groups; keys are field names (must exist on this content type).
    kind: z.enum(["auto2col", "single", "manual"]),
    // Only valid when kind = "manual". Each group's fields render in the listed order;
    // a group's fields all share the same row alignment.
    groups: z.array(formLayoutColumnSchema).optional(),
    // Default wide keys in manual mode — these fields always take the full row width.
    wide: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine(
    (l) =>
      l.kind !== "manual" ||
      (Array.isArray(l.groups) && l.groups.length >= 1),
    { message: 'layout "manual" requires at least one group', path: ["groups"] },
  );

const contentTypeSchema = z
  .object({
    name: z.string().regex(TYPE_NAME_RE, "invalid content type name"),
    label: localized().optional(),
    slugField: z.string().optional(),
    fields: z.array(fieldSchema).min(1),
    // Alpha 升級:宣告此 type 為 public(免登入可 POST 建立新 entry)。
    // dispatch(/api/ext/...)看到 POST + 對應 type public:true → 跳 requireAuth。
    // Origin check / 防護層仍由 dispatch 統一做(不繞)。
    public: z.boolean().optional(),
    // A(docs/spec-declarative-notify-schedule.md):public create 成功後 best-effort
    // 寄通知信(收件人 = core.notifyEmail 設定)。只對 public create 路徑生效
    // (crud.ts POST 的 ct.public 分支);public 非 true 時無作用 —— 不需 zod 交叉檢查,
    // 執行層自然不會走到(見 dx/notify.ts)。
    notifyOnCreate: z.boolean().optional(),
    // Progressive form layout:extensions 可以選擇 baseline(auto2col / single)或
    // 宣告 manual 來自定欄位順序與寬度。沒寫 → 跑 auto2col 的舊邏輯。
    layout: formLayoutSchema.optional(),
  })
  .strict();

// ---- settings(與 code extension SettingField 同形狀)----

const settingOptionSchema = z
  .object({
    value: z.string(),
    // settings select 的 option 已是 value/label 分離(不同於 content-type select
    // 的 value=label 糾纏),故 label 可乾淨 localize(spec §1 #11)。
    label: localized(),
  })
  .strict();

const settingFieldSchema = z
  .object({
    key: z.string().regex(FIELD_KEY_RE, "invalid setting key"),
    label: localized(),
    description: localized().optional(),
    default: z.unknown(),
    secret: z.boolean().optional(),
    type: z.enum(["text", "textarea", "number", "boolean", "select"]),
    options: z.array(settingOptionSchema).optional(),
  })
  .strict()
  .refine((s) => s.type !== "select" || (s.options?.length ?? 0) >= 1, {
    message: "select setting requires options",
    path: ["options"],
  });

// ---- admin / public / hooks ----

// core-v2 §3.5:listing layout。"table"(預設,單列表格)、"grid"(響應式卡片格)或
// "stacked"(vendored StackedList/StackedListItem sweep-in 動效,見 ExtRecentCard)。
// 缺省 = table(back-compat)。"table"/"grid" 為 CORE_API minor bump(1.0.0 → 1.1.0);
// "stacked" 為 1.7.0(見 version.ts changelog)。
const LAYOUT_VALUES = ["table", "grid", "stacked"] as const;
export type ListLayout = (typeof LAYOUT_VALUES)[number];

const adminPageSchema = z
  .object({
    slug: z.string(), // "" = extension 主頁
    title: localized(),
    view: z.literal("collection"),
    contentType: z.string(),
    layout: z.enum(LAYOUT_VALUES).optional(), // 缺省 → "table"
  })
  .strict();

// ---- forms(提交成功回饋,被 publicRoute view:"form" 引用,須在 publicRoute 之前宣告)----
const formSuccessSchema = z
  .object({
    message: localized().optional(),
  })
  .strict();

const publicRouteSchema = z
  .object({
    pattern: z.string().regex(ROUTE_PATTERN_RE, "invalid route pattern"),
    view: z.enum(["list", "detail", "form"]), // Alpha:form = 公開匿名表單(走 contentType + public:true)
    contentType: z.string(),
    layout: z.enum(LAYOUT_VALUES).optional(), // list 專用;缺省 → "table"
    // form view 專用:提交成功回饋
    success: formSuccessSchema.optional(),
    // 1.7.0:form view 專用。content type 有 ≥4 個「公開可渲染」欄位時,把表單拆成
    // vendored Stepper 的多步(每步 ≤3 欄,最後一步送出)——見 PublicFormView(FormView
    // public mode)。只在 view:"form" 合法(refine 見下);其餘 view 帶此欄位一律拒絕。
    stepped: z.boolean().optional(),
  })
  .strict()
  .refine((r) => r.layout === undefined || r.view === "list", {
    message: '`layout` is only valid when view is "list"',
    path: ["layout"],
  })
  .refine((r) => r.success === undefined || r.view === "form", {
    message: '`success` is only valid when view is "form"',
    path: ["success"],
  })
  .refine((r) => r.stepped === undefined || r.view === "form", {
    message: '`stepped` is only valid when view is "form"',
    path: ["stepped"],
  });

const hookActionSchema = z
  .object({
    action: z.literal("webhook"),
    url: z.string().regex(/^https:\/\//, "webhook url must be https"),
    secretSetting: z.string().optional(),
  })
  .strict();

// ---- dashboard cards(roadmap #16:extension 貢獻的 dashboard 卡)----
// 每張卡引用一個「本 extension 已宣告」的 contentTypes[].name(交叉檢查在 top-level
// superRefine,錯誤會點名該 contentType)。兩種 kind:
//   stat   → 顯示該 type 的 entry 總數;可選 status 只計該狀態(recent 不可帶 status)。
//   recent → 顯示最近更新的 limit 筆(int 1..10,預設 5;stat 不可帶 limit)。
// 陣列上限 4 張(.max(4)),object 一律 .strict()。加入此欄位為 CORE_API minor bump
// (1.5.0 → 1.6.0):schema 為 .strict(),舊 core 會整包拒絕帶此欄位的 manifest,故
// 使用者其 coreApi 必須宣告 "^1.6.0"。
const dashboardCardSchema = z
  .object({
    kind: z.enum(["stat", "recent"]),
    // 須對應某個 contentTypes[].name(superRefine 交叉驗;schema 端不做 pattern 綁定)。
    contentType: z.string().min(1),
    // 缺省 → 該 contentType 的 label / name(由消費端 fallback)。
    title: localized().optional(),
    // stat 專用:只計此 status 的 entry(recent 帶 status → refine 擋)。
    status: z.enum(["draft", "published"]).optional(),
    // recent 專用:回傳筆數 1..10,缺省 5(stat 帶 limit → refine 擋)。
    limit: z.number().int().min(1).max(10).optional(),
  })
  .strict()
  .refine((c) => c.kind === "stat" || c.status === undefined, {
    message: "`status` is only valid on stat cards",
    path: ["status"],
  })
  .refine((c) => c.kind === "recent" || c.limit === undefined, {
    message: "`limit` is only valid on recent cards",
    path: ["limit"],
  });

// ---- forms(core-v2 forms §:撤掉,改用 contentType+public:true+view:"form")----
// 原本這裡有 formSchema;現已撤除。
// 公開表單的「欄位 + success + 路由」現由 DeclarativeContentType + publicRoute view:"form" 承擔，
// 並直接共用泛用 FormView(public mode)，不再維護獨立 PublicFormView。

// ---- theme tokens(1.8.0:optional design tokens tinting public pages)----
// manifest 可宣告 theme,值會被 render 進 public 頁面的 inline style(CSS 自訂屬性
// --ext-accent / --ext-bg / --ext-muted / --ext-radius)。因為值直接進 inline style,
// 「注入安全」是硬需求:colors 只允許 hex 或 oklch/rgb/hsl(...) 的受限字元集;radius
// 只允許 <number>px | <number>rem。任何含 ; { } < > " ' 的值一律拒絕(regex 已排除,
// 另加一道 refine 明確擋掉,defense-in-depth)。所有欄位皆 optional,object .strict()。
const THEME_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|(oklch|rgb|hsl)\([0-9a-zA-Z .,%/-]*\))$/;
const THEME_RADIUS_RE = /^\d+(\.\d+)?(px|rem)$/;
const THEME_INJECTION_RE = /[;{}<>"']/;

const themeColorSchema = z
  .string()
  .regex(THEME_COLOR_RE, "invalid color (expect hex or oklch/rgb/hsl(...))")
  .refine((v) => !THEME_INJECTION_RE.test(v), {
    message: "color must not contain ; { } < > \" '",
  });

const themeRadiusSchema = z
  .string()
  .regex(THEME_RADIUS_RE, "invalid radius (expect <number>px or <number>rem)")
  .refine((v) => !THEME_INJECTION_RE.test(v), {
    message: "radius must not contain ; { } < > \" '",
  });

const themeSchema = z
  .object({
    accent: themeColorSchema.optional(),
    background: themeColorSchema.optional(),
    muted: themeColorSchema.optional(),
    radius: themeRadiusSchema.optional(),
  })
  .strict();

// ---- schedule(B:docs/spec-declarative-notify-schedule.md —— 宣告式排程動作,騎在
// ext-jobs 表面上(docs/spec-extension-jobs.md),v1 只有一個 op:deleteOlderThan)----
// id 同 spec-extension-jobs.md 的 job id 規則(^[a-z][a-z0-9-]{0,30}$)且陣列內唯一
// (refine);every 為分鐘數,整數 ≥1。action.contentType 指向本 manifest
// contentTypes[].name —— 不做 zod 交叉檢查,interpret 層對不存在的 type 軟跳過
// (同 adminPages 慣例)。

const SCHEDULE_ID_RE = /^[a-z][a-z0-9-]{0,30}$/;
const SCHEDULE_MAX_ITEMS = 8;

const scheduleActionSchema = z
  .object({
    op: z.literal("deleteOlderThan"),
    contentType: z.string().min(1),
    days: z.number().int().min(1),
  })
  .strict();

const scheduleItemSchema = z
  .object({
    id: z.string().regex(SCHEDULE_ID_RE, "invalid schedule id"),
    every: z.number().int().min(1),
    action: scheduleActionSchema,
  })
  .strict();

const scheduleSchema = z
  .array(scheduleItemSchema)
  .max(SCHEDULE_MAX_ITEMS)
  .refine((items) => new Set(items.map((i) => i.id)).size === items.length, {
    message: "duplicate schedule id",
  })
  .optional();

// ---- loginProvider(spec-login-providers.md §4:CORE_API 1.16.0)----
// declarative 第三方 OIDC 登入宣告。會變的部分全是資料:issuer(discovery 由引擎抓)、
// scopes、登入按鈕外觀。client id/secret 走既有 settings[](secret:true)慣例,不在此宣告。
// button.svg 經 svg-guard 驗證(allowlist;驗證失敗 = manifest 驗證失敗,fail-loud);
// background/foreground 沿用既有 themeColorSchema(注入安全同 theme tokens)。
const loginProviderButtonSchema = z
  .object({
    label: z.string().min(1).max(40), // 如 "使用 Google 繼續"
    svg: z
      .string()
      .max(4000)
      .superRefine((v, ctx) => {
        // svg-guard 的 reason 直接帶進 zod issue message(fail-loud、可讀)。
        const result = validateSvg(v);
        if (!result.ok) {
          ctx.addIssue({
            code: "custom",
            message: `invalid button.svg: ${result.reason}`,
          });
        }
      })
      .optional(),
    background: themeColorSchema.optional(),
    foreground: themeColorSchema.optional(),
  })
  .strict();

const loginProviderSchema = z
  .object({
    issuer: z.string().regex(/^https:\/\//, "issuer must be https"), // OIDC issuer,discovery 由引擎抓
    scopes: z.array(z.string().min(1)).max(8).optional(), // 預設 ["openid","profile","email"]
    button: loginProviderButtonSchema,
  })
  .strict();

// ---- top-level manifest ----

export const manifestSchema = z
  .object({
    kind: z.literal("declarative"),
    id: z.string().regex(ID_RE, "invalid extension id"),
    // spec §1 #1/#2:頂層使用者可見的 name/description 亦可 localize(union;純字串
    // manifest 全相容)。id 是機器識別字,永不 localize(仍 z.string())。
    name: localized(z.string().min(1)),
    version: z.string().regex(VERSION_RE, "invalid version (expect x.y.z)"),
    coreApi: z.string().regex(CORE_API_RE, "invalid coreApi range"),
    description: localized().optional(),
    // declarative extension icon hint (lucide token). 用於 admin sidebar / menus。
    icon: z.string().optional(),
    // PNG icon relative path in registry (e.g. "icon.png" under extensions/<id>/)
    iconUrl: z.string().optional(),
    // Top banner image relative path (e.g. "banner.png")
    banner: z.string().optional(),
    // Screenshots list (relative paths)
    screenshots: z.array(z.string()).optional(),
    // 部署類型：instant（立即可用）、progressive（安裝後可用但 rebuild 後體驗完整）、code-only（必須 rebuild）
    deployment: z.enum(["instant", "progressive", "code-only"]).optional(),
    // 安裝時需要 prompt user 輸入的欄位（線上商店會顯示表單）
    installPrompts: z
      .array(
        z.object({
          key: z.string().min(1),
          label: localized(z.string().min(1)),
          type: z.enum(["text", "textarea", "number", "boolean"]),
          required: z.boolean().optional(),
          secret: z.boolean().optional(),
          description: localized().optional(),
        }),
      )
      .optional(),
    // 自訂 API endpoint(其他 app 可呼叫這些端點,拿到固定形狀的回傳值)。
    // 1.9.0(roadmap #1):由 schema 孤兒變為生效 —— 成為「哪些 content type 對外
    // 開放」的唯讀白名單(見 Public Content API route 的 gating)。read-only v1:
    // method 只允許 "GET"(其餘 method reject —— 寫入型 API 非本版範圍);新增可選
    // contentType 指向自己宣告的 content type。responseShape 保留供文件用途,不強制。
    customApiRoutes: z
      .array(
        z
          .object({
            // read-only:v1 只放行 GET。舊 core 收 POST/PUT/DELETE,新 core 只收 GET
            // (使用 customApiRoutes 者其 coreApi 必須宣告 "^1.9.0")。
            method: z.literal("GET"),
            path: z.string().min(1),
            // 指向自己宣告的 content type(local name)。列入者即「對外開放」。
            contentType: z.string().min(1).optional(),
            responseShape: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      )
      .optional(),
    // 宣告這個 extension 需要哪些平台能力（core-v2 roadmap #17:install-time
    // feature-gating）。zod 只驗證「非空字串、≤16 項」，故意不比對已知功能名的
    // enum —— 未知名稱可能來自「更新版本的 core」新增的功能，schema 層驗證太早，
    // 應留給 install route 用 src/ext/features.ts 的 missingCapabilities() 做比對。
    capabilities: z.array(z.string().min(1)).max(16).optional(),
    // 服務需求(與 capabilities 刻意分軸):capabilities 是「core 版本功能表」
    // (features.ts 靜態清單),requires 是「provider 層要有誰在場」(providers.ts
    // 的 capability 註冊,如 email:send、cron:tick —— 可能由 core 內建,也可能要
    // 先裝提供該服務的 code extension)。判定在 install route / Browse UI:
    //   - optional 缺席 → 可裝,UI 顯示「建議」。
    //   - 非 optional 缺席 → 擋安裝(同 features.ts 哲學:裝上去 runtime 才爆,
    //     不如當下講清楚要先裝哪個提供者)。
    // capability 命名同 providers.ts 慣例:`name` 或 `name:verb`(小寫/數字/連字號)。
    requires: z
      .array(
        z
          .object({
            capability: z
              .string()
              .regex(
                /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)?$/,
                "invalid service capability name",
              ),
            optional: z.boolean().optional(),
            /** 顯示給使用者的用途說明(Browse chips tooltip)。 */
            reason: localized(z.string().max(200)).optional(),
          })
          .strict(),
      )
      .max(16)
      .optional(),
    // ---- marketplace metadata(信任 + 發現性;消費端 RegistryBrowser)----
    // 作者/出處
    author: z
      .object({
        name: z.string().min(1),
        url: z.string().regex(/^https:\/\//, "author url must be https").optional(),
        email: z.string().email().optional(),
      })
      .optional(),
    homepage: z.string().regex(/^https:\/\//, "homepage must be https").optional(),
    repository: z.string().regex(/^https:\/\//, "repository must be https").optional(),
    // SPDX id(如 "MIT");純顯示,不做 SPDX 驗證
    license: z.string().min(1).optional(),
    // 發現性:搜尋比對 + detail 頁 chips
    tags: z.array(z.string().min(1)).max(8).optional(),
    category: z
      .enum(["content", "media", "commerce", "integration", "utility", "theme"])
      .optional(),
    support: z
      .object({
        url: z.string().regex(/^https:\/\//, "support url must be https").optional(),
        email: z.string().email().optional(),
      })
      .optional(),
    // 1.8.0:optional design tokens。渲染進 public 頁面 inline style;admin 無視。
    theme: themeSchema.optional(),
    // 1.8.0:optional co-located stylesheet。v1 固定檔名 "style.css"(literal —— 不收
    // 任意路徑,杜絕 path traversal / 抓取任意資產)。install 時 fetch
    // `<source>/extensions/<id>/style.css`,經 validateStylesheet(stylesheet-guard.ts)
    // 通過才存進 declarative_extensions.stylesheet 欄位;render 時只注入該 extension
    // 自己的 public 頁面(scoped 於 [data-ext="<id>"])。manifest 不寫 → 欄位清 NULL。
    stylesheet: z.literal("style.css").optional(),
    contentTypes: z.array(contentTypeSchema).optional(),
    settings: z.array(settingFieldSchema).optional(),
    adminPages: z.array(adminPageSchema).optional(),
    publicRoutes: z.array(publicRouteSchema).optional(),
    // 可選 OG image 設定:宣告 public route 的 Open Graph preview 走哪個核心
    // og-template(template 名對應到 src/components/og/<slug>.tsx)。
    og: z
      .object({
        image: z
          .object({
            template: z.string().min(1),
            brand: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    // 可選 DDL:每條為單一 idempotent statement,**必須** 以
    // `CREATE (TABLE|UNIQUE INDEX|INDEX) ... IF NOT EXISTS` 起頭(解析器只放行
    // 這三種);不支援 `;` 切割或 inline `;` —— 一條 statement 一個 string;DROP /
    // INSERT / UPDATE / ALTER 留待 v1.1(需 transaction 語意)。
    // runtime 在 install 與 loader 首次 interpret 兩處呼叫 helper 套用,並把
    // `<extId>:<paddedIdx>` 寫進 `ext_migrations` 表供 skip-on-retry。
    migrations: z
      .array(
        z
          .string()
          .min(1)
          .refine((s) => !s.includes(";"), {
            message:
              "declarative migrations entries must contain a single statement (no inline ';')",
          })
          .refine(
            (s) =>
              /\bCREATE\s+(TABLE|UNIQUE\s+INDEX|INDEX)\s+IF\s+NOT\s+EXISTS\b/i.test(
                s,
              ),
            {
              message:
                "declarative migration must use 'CREATE (TABLE|UNIQUE INDEX|INDEX) ... IF NOT EXISTS' (idempotency required)",
            },
          ),
      )
      .optional(),
    // hook 名 -> action 綁定陣列。v1 僅 webhook。
    on: z.record(z.string(), z.array(hookActionSchema)).optional(),
    // roadmap #16:extension 貢獻的 dashboard 卡(≤4;contentType 須引用已宣告的
    // contentTypes[].name,交叉檢查見下方 superRefine)。
    dashboardCards: z.array(dashboardCardSchema).max(4).optional(),
    // B(1.11.0):宣告式排程動作(≤8),interpret 層轉為 Extension.jobs,騎在
    // ext-jobs 引擎上執行(見上方 schedule 區塊的定義)。
    schedule: scheduleSchema,
    // spec-login-providers.md §4(1.16.0):declarative 第三方 OIDC 登入宣告。
    // issuer/scopes/button;client 憑證走 settings[](secret:true)慣例。manifestSchema
    // 是 .strict() —— 宣告 loginProvider 的 manifest 在 <1.16.0 的 core 會整包驗證失敗,
    // 故其 coreApi 必須宣告 "^1.16.0"。
    loginProvider: loginProviderSchema.optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    // installPrompts 是「settings 的 UX 前門」——每個 prompt.key 都必須對應到一個
    // 已宣告的 settings[].key,且 secret 旗標須與該 setting 一致(install 端才知道
    // 該不該走加密管線,見 install route + setExtensionSettingsRaw)。settings 仍是
    // 唯一真相來源,prompts 只是安裝時預填其值的表單。
    if (m.installPrompts && m.installPrompts.length > 0) {
      const settingsByKey = new Map((m.settings ?? []).map((s) => [s.key, s]));
      m.installPrompts.forEach((prompt, idx) => {
        const setting = settingsByKey.get(prompt.key);
        if (!setting) {
          ctx.addIssue({
            code: "custom",
            message: `installPrompts[${idx}].key "${prompt.key}" does not reference an existing settings[].key`,
            path: ["installPrompts", idx, "key"],
          });
          return;
        }
        const promptSecret = prompt.secret ?? false;
        const settingSecret = setting.secret ?? false;
        if (promptSecret !== settingSecret) {
          ctx.addIssue({
            code: "custom",
            message: `installPrompts[${idx}].secret must match settings[].secret for key "${prompt.key}"`,
            path: ["installPrompts", idx, "secret"],
          });
        }
      });
    }

    // roadmap #16:每張 dashboardCard 都必須引用一個已宣告的 contentTypes[].name
    // (與 installPrompts 同模式的交叉檢查;錯誤點名該 contentType,方便作者定位)。
    if (m.dashboardCards && m.dashboardCards.length > 0) {
      const typeNames = new Set((m.contentTypes ?? []).map((c) => c.name));
      m.dashboardCards.forEach((card, idx) => {
        if (!typeNames.has(card.contentType)) {
          ctx.addIssue({
            code: "custom",
            message: `dashboardCards[${idx}].contentType "${card.contentType}" does not reference a declared contentTypes[].name`,
            path: ["dashboardCards", idx, "contentType"],
          });
        }
      });
    }
  });

// leaf-only 欄位型別(group/repeater/blocks 的 nested 子欄位一律為此形狀)。
export type DeclarativeLeafField = z.infer<typeof leafFieldSchema>;

// blocks 的具名 block 宣告(name + leaf 子欄位)。
export type DeclarativeBlockDef = z.infer<typeof blockDefSchema>;

// DeclarativeField:top-level 欄位型別。validation 走上方的 discriminated union
// (fieldSchema — 嚴格分辨 leaf vs group/repeater/blocks 各自的必填 nested defs);
// 但「消費端」型別刻意攤平為單一 interface,結構欄位專屬屬性(fields/blocks/max)
// 皆 optional。理由:codebase 全程以 flat ContentFieldDef 對待欄位(component 直接
// 讀 field.options / field.to / field.fields),攤平型別免去每個 call site 都要 narrow
// union。runtime 值仍由 union schema 保證形狀正確(不合法的欄位 parseManifest 直接
// 擋掉),故攤平型別不放寬任何實際約束。
export interface DeclarativeField {
  key: string;
  type: (typeof FIELD_TYPES)[number];
  /** spec §1 #4–#6:可 localize(union;消費端一律走 resolveLocalizedString)。 */
  label?: LocalizedString;
  required?: boolean;
  /** select 專用。 */
  options?: string[];
  /** relation/relations 專用:目標 content type key "<extId>.<typeName>"。 */
  to?: string;
  /** text 欄位:multiline → TextFullscreenEditor(可放大寫作)。 */
  multiline?: boolean;
  /** group/repeater 專用:nested leaf 子欄位(一層 nesting 上限)。 */
  fields?: DeclarativeLeafField[];
  /** blocks 專用:宣告的具名 block 形狀。 */
  blocks?: DeclarativeBlockDef[];
  /** repeater/blocks 專用:實例數上限。 */
  max?: number;
}

// DeclarativeContentType:同理攤平 fields 為 DeclarativeField[](見上)。其餘欄位
// 與 contentTypeSchema 一致。
export interface DeclarativeContentType {
  name: string;
  /** spec §1 #3:可 localize(union;消費端一律走 resolveLocalizedString)。 */
  label?: LocalizedString;
  slugField?: string;
  fields: DeclarativeField[];
  /** Alpha:此 type 對外公開(匿名可建立新 entry)。 */
  public?: boolean;
  /** A(docs/spec-declarative-notify-schedule.md):public create 成功後 best-effort
   * 寄通知信;只在 `public` 為 true 時生效。 */
  notifyOnCreate?: boolean;
  /** Progressive form layout:extensions 可以選擇 baseline(auto2col / single)或
   * 宣告 manual 來自定欄位順序與寬度。沒寫 → FormView 跑 auto2col 預設。 */
  layout?: {
    /** auto2col | single | manual。 */
    kind: "auto2col" | "single" | "manual";
    /** Only valid when kind = "manual". 群組內的 field 共享同一行 / 同寬。 */
    groups?: { fields: string[]; fullWidth?: boolean }[];
    /** Default wide keys —這些欄位在 manual 模式下仍吃滿整列。 */
    wide?: string[];
  };
}

// 1.8.0:public 頁面 design tokens(全部 optional;注入安全由 themeSchema regex + refine 保證)。
export type DeclarativeTheme = z.infer<typeof themeSchema>;
export type DeclarativeSettingField = z.infer<typeof settingFieldSchema>;
export type DeclarativeAdminPage = z.infer<typeof adminPageSchema>;
export type DeclarativePublicRoute = z.infer<typeof publicRouteSchema>;
export type DeclarativeHookAction = z.infer<typeof hookActionSchema>;
// roadmap #16:單張 dashboard 卡(stat/recent)。refine 不改變推斷型別,故此 infer
// 與消費端(interpret / dashboard-cards)所需的 flat 形狀一致。
export type DeclarativeDashboardCard = z.infer<typeof dashboardCardSchema>;
// B(1.11.0):單一宣告式排程項目(id/every + deleteOlderThan action)。
export type DeclarativeScheduleItem = z.infer<typeof scheduleItemSchema>;
// spec-login-providers.md §4(1.16.0):declarative 第三方 OIDC 登入宣告。
export type DeclarativeLoginProvider = z.infer<typeof loginProviderSchema>;

// DeclarativeManifest:攤平 contentTypes 為 DeclarativeContentType[](fields 用
// flat DeclarativeField)。其餘欄位沿用 zod 推斷型別。runtime 值仍由 manifestSchema
// 驗證(見 parseManifest 的 safeParse + 型別橋接)。
export interface DeclarativeManifest {
  kind: "declarative";
  id: string;
  /** spec §1 #1/#2:可 localize(union)。id 為機器識別字,永不 localize。 */
  name: LocalizedString;
  version: string;
  coreApi: string;
  description?: LocalizedString;
  /** lucide token used by admin nav/menu (e.g. "images", "mail", "layout-template"). */
  icon?: string;
  /** PNG icon relative path in registry (e.g. "icon.png"). */
  iconUrl?: string;
  /** Top banner image relative path (e.g. "banner.png"). */
  banner?: string;
  /** Screenshots list (relative paths). */
  screenshots?: string[];
  /** 部署類型:instant=立即可用;progressive=安裝後可用,重建後體驗完整;code-only=必須重建。 */
  deployment?: "instant" | "progressive" | "code-only";
  /** 安裝時需要 prompt user 輸入的欄位(線上商店會顯示表單)。 */
  installPrompts?: Array<{
    key: string;
    /** spec §1 #15/#16:union。install-time Browse 表面的顯示 resolve 屬 surface B,
     * v1 未接線(見 version.ts 1.17.0 changelog);此處型別保留 union 以容納翻譯。 */
    label: LocalizedString;
    type: "text" | "textarea" | "number" | "boolean";
    required?: boolean;
    secret?: boolean;
    description?: LocalizedString;
  }>;
  /** 1.9.0:自訂 API endpoint 定義(read-only v1:method 只允許 "GET")。宣告後成為
   * 「哪些 content type 對外開放」的唯讀白名單;contentType 指向自己宣告的 type。 */
  customApiRoutes?: Array<{
    method: "GET";
    path: string;
    contentType?: string;
    responseShape?: Record<string, unknown>;
  }>;
  /** 這個 extension 需要的平台能力(install-time 由 features.ts 比對是否支援)。 */
  capabilities?: string[];
  /** 服務需求:provider 層要有誰在場(providers.ts capability,如 email:send)。
   * 非 optional 缺席 → install 擋下;optional 缺席 → 可裝,UI 顯示建議。 */
  requires?: Array<{
    capability: string;
    optional?: boolean;
    /** spec §1 #17:union。Browse chips tooltip 顯示屬 surface B,v1 未接線。 */
    reason?: LocalizedString;
  }>;
  /** 作者/出處(marketplace 信任資訊)。 */
  author?: { name: string; url?: string; email?: string };
  homepage?: string;
  repository?: string;
  /** SPDX id,如 "MIT"。 */
  license?: string;
  /** 發現性標籤(≤8;搜尋比對 + detail chips)。 */
  tags?: string[];
  category?: "content" | "media" | "commerce" | "integration" | "utility" | "theme";
  support?: { url?: string; email?: string };
  /** 1.8.0:public 頁面 design tokens(accent/background/muted colors + radius);全部 optional。 */
  theme?: {
    accent?: string;
    background?: string;
    muted?: string;
    radius?: string;
  };
  /** 1.8.0:co-located stylesheet(v1 固定為字面 "style.css")。install 時抓取、經
   * validateStylesheet 驗證後存進 declarative_extensions.stylesheet;僅注入該 extension
   * public 頁面。實際 CSS 存 DB 欄位而非 manifest —— 此欄位僅是「有無 co-located sheet」的宣告。 */
  stylesheet?: "style.css";
  /** OG image 設定:image.template 對應 src/components/og/<slug>.tsx。 */
  og?: {
    image?: {
      template: string;
      brand?: string;
    };
  };
  contentTypes?: DeclarativeContentType[];
  settings?: DeclarativeSettingField[];
  adminPages?: DeclarativeAdminPage[];
  publicRoutes?: DeclarativePublicRoute[];
  /** 對應 `migrations` schema 的 flat 型別 —— 為相容 runtime 的 `?` 寫入 d1。 */
  migrations?: string[];
  on?: Record<string, DeclarativeHookAction[]>;
  /** roadmap #16:extension 貢獻的 dashboard 卡(stat/recent);≤4 張,contentType
   * 須引用已宣告的 contentTypes[].name(superRefine 交叉驗)。 */
  dashboardCards?: DeclarativeDashboardCard[];
  /** B(1.11.0):宣告式排程動作(≤8);interpret 轉為 Extension.jobs,騎在 ext-jobs
   * 引擎上執行。action.contentType 指向本 manifest contentTypes[].name(不做 zod
   * 交叉檢查,interpret 對不存在的 type 軟跳過)。 */
  schedule?: DeclarativeScheduleItem[];
  /** spec-login-providers.md §4(1.16.0):declarative 第三方 OIDC 登入宣告。
   * issuer(discovery 由引擎抓)/ scopes / button 外觀;client id/secret 走 settings[]
   * (secret:true)慣例,引擎按 `ext.<extId>.clientId` / `.clientSecret` key 直接讀。 */
  loginProvider?: DeclarativeLoginProvider;
}

export interface ParseResult {
  ok: boolean;
  manifest?: DeclarativeManifest;
  error?: string;
}

/**
 * 驗證任意 JSON 為合法 declarative manifest。成功回傳 typed manifest;
 * 失敗回傳可讀 error 字串(不 throw —— 呼叫端可選擇 skip+log 或回 400)。
 */
export function parseManifest(json: unknown): ParseResult {
  const result = manifestSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return { ok: false, error: issues };
  }
  // 型別橋接:result.data 的 fields 是嚴格 union(validation 用),與消費端攤平的
  // DeclarativeManifest 執行期形狀完全相同,僅編譯期表示不同。透過 unknown 收斂到
  // flat 型別(見 DeclarativeField 註解)。
  return { ok: true, manifest: result.data as unknown as DeclarativeManifest };
}
