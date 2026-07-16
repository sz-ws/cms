// core-v2 §1:核心 API 版本。extension manifest 以 coreApi semver range 宣告相容範圍,
// enable/install 時對此常數檢查。破壞性變更(ApiCtx/hook 簽名/provider 介面)→ major bump;
// 新 hook/capability/field type → minor bump。
// 1.1.0(§3.5):listing layout capability(adminPage/publicRoute 的 layout:"table"|"grid")。
//   純新增、可選、缺省 = 舊 table 行為 → back-compat,coreApi "^1.0.0" 仍以 caret 相容。
// 1.2.0(08 §1):relation/relations field types(content-to-content 關聯)。新 field
//   type = minor bump(§1「新 hooks/capabilities/field types → minor」)。純新增:
//   既有 manifest 不含 relation → 行為不變,coreApi "^1.0.0" / "^1.1.0" 皆以 caret
//   相容 1.2.0(同 major、minor 較新;見 semver.ts 的 caret 判定)。
// 1.3.0(Tier 2 v1.2):group/repeater/blocks structural field types(巢狀 + 可重複
//   內容 + 具名 block 頁面建構器)。新 field type = minor bump(§1)。純新增、可選:
//   既有 manifest 不含結構欄位 → 行為不變。既有 "^1.x" manifest 皆以 caret 相容
//   1.3.0(同 major、minor 較新)。value shape 為全新 key,無既有資料形狀變更 → 非 major。
// 1.4.0(forms,歷史):declarative forms 引擎(manifest `forms` + form:submitted +
//   /api/forms 端點 + form_submissions 表)。該引擎其後被 contentTypes `public:true`
//   + publicRoutes view:"form" 取代並移除;版號保留為歷史紀錄,不回收。
// 1.5.0(marketplace metadata):manifest 新增 author/homepage/repository/license/
//   tags/category/support(RegistryBrowser 顯示 + 搜尋)。純新增、可選 → minor bump。
//   注意:manifestSchema 是 .strict() —— 帶新欄位的 manifest 在 <1.5.0 的 core 會
//   整包驗證失敗,所以使用這些欄位的 manifest 其 coreApi 必須宣告 "^1.5.0"。
// 1.6.0(roadmap #16:composable dashboard):manifest 新增 dashboardCards(extension
//   貢獻的 dashboard 卡:stat 總數 / recent 最近更新;≤4 張,contentType 須引用已宣告
//   的 contentTypes[].name)。純新增、可選 → minor bump。注意:manifestSchema 是
//   .strict() —— 帶 dashboardCards 的 manifest 在 <1.6.0 的 core 會整包驗證失敗,
//   所以使用此欄位的 manifest 其 coreApi 必須宣告 "^1.6.0"。
// 1.7.0(vendored vocabulary components 開放給 declarative extensions:StackedList /
//   StatusButton / Stepper,見 src/components/ui/{stacked-list,status-button,stepper}.tsx):
//   - layout enum(adminPage/publicRoute)新增 "stacked" 值 —— 新 enum 值同「新 field
//     type → minor bump」的精神(§1)。CollectionView 與 ListView 兩個 list surface
//     都吃這個值,渲染為 StackedList/StackedListItem(sweep-in 動效,同 ExtRecentCard)。
//   - publicRoute 新增 stepped(z.boolean().optional(),僅 view:"form" 合法,refine
//     擋掉其餘 view)。PublicFormView(FormView public mode)在 stepped:true 且欄位數
//     ≥4 時把表單拆成 vendored Stepper 的多步(每步 ≤3 欄,最後一步送出)。
//   - PublicFormView 的送出鈕改用 StatusButton(無新 manifest 旗標,純元件替換)。
//   manifestSchema 是 .strict() —— 宣告 layout:"stacked" 或 stepped 的 manifest 在
//   <1.7.0 的 core 會整包驗證失敗,所以使用這些欄位的 manifest 其 coreApi 必須宣告
//   "^1.7.0"。
// 1.8.0(manifest `theme` design tokens + `stylesheet` co-located CSS;共用此 bump):
//   - manifest 新增可選 `theme` object(全欄位可選:accent / background / muted 三個
//     顏色 + radius 一個長度)。值會被 render 進 public 頁面的 inline style,成為 CSS
//     自訂屬性 --ext-accent / --ext-bg / --ext-muted / --ext-radius;泛用 public views
//     (list/detail/form)以 var(--ext-*, <current>) 取用,fallback 為現行 Paper & Ink
//     值 —— tokens 只 tint 既有設計,不取代;admin 頁完全無視 theme。注入安全為硬需求:
//     顏色只收 hex 或 oklch/rgb/hsl(...) 受限字元集,radius 只收 <number>px|rem,任何含
//     ; { } < > " ' 的值一律拒絕(themeSchema regex + refine 雙重把關)。新增可選欄位 =
//     minor bump(§1)。
//   - `stylesheet` 欄位(本批落地):optional literal "style.css" —— extension 可 co-locate
//     一份受限自訂 CSS。install 時抓取 `<source>/extensions/<id>/style.css`,經
//     stylesheet-guard.validateStylesheet(REJECT-not-rewrite:@import/expression/url() 外站/
//     style-tag breakout/不平衡括號…一律拒)通過才存進 declarative_extensions.stylesheet 欄。
//     render 時以 CSS nesting 包成 `[data-ext="<id>"] { … }` 注入該 extension 自己的 public
//     頁面(admin 無視,同 theme)。與 `theme` 共用此 1.8.0 minor bump,避免 release 前連續
//     兩次 bump。
//   manifestSchema 是 .strict() —— 宣告 `theme` 或 `stylesheet` 的 manifest 在 <1.8.0 的
//   core 會整包驗證失敗,所以使用這些欄位的 manifest 其 coreApi 必須宣告 "^1.8.0"。
// 1.9.0(roadmap #1:Public Content API + inbound API tokens;customApiRoutes 生效):
//   - 新增 inbound bearer-token 認證能力(api_tokens 表 + src/lib/api-token.ts)與公開
//     read-only Content API(GET /api/content/<extId>/<type>[/<slug>],強制 published-only,
//     走既有 cachedPublicQuery/cachedPublicGetBySlug tagged cache)。這是新的 core feature,
//     故為 minor bump。
//   - customApiRoutes 由「schema 孤兒」變為生效:manifest 若宣告 customApiRoutes,則成為
//     「哪些 content type 對外開放」的唯讀白名單(未列入的 type → 403 not_exposed);完全
//     未宣告則預設全部 published content types 皆可讀(向後相容,零設定即 headless)。
//   - customApiRoutes zod 收窄:method 限縮為只允許 "GET"(read-only v1),新增可選
//     contentType 欄位(指向自己宣告的 type)。這改變了既有 schema 的形狀:宣告非 GET
//     method 或帶 contentType 的 manifest 在 <1.9.0 的 core 會驗證失敗(method 舊 core 收
//     POST/PUT/DELETE、新 core 只收 GET;contentType 為新欄位,.strict() 直接 reject)。
//     故使用 customApiRoutes 的 manifest 其 coreApi 必須宣告 "^1.9.0"。
// 1.10.0(spec-extension-jobs.md:extension jobs 表面):manifest 新增可選 `jobs`
//   (Extension.jobs?: ExtJobRegistration[] —— 週期性宣告 `every` 分鐘數 / 純
//   handler)。CoreServices 新增 `jobs: ScopedJobs`(schedule 一次性任務 / cancel),
//   scope 綁定至呼叫端 extId。執行併入 src/lib/jobs.ts 的新 core job `ext-jobs`
//   (runDueJobs 既有迭代,lazy sweep / manual / cron:tick 皆自動驅動,無新觸發路徑)。
//   純新增、可選欄位 + 新 core job(對既有 publish-due 零行為變更)→ minor bump(§1)。
//   manifestSchema 是 .passthrough()(非 declarative 的 .strict())——舊 manifest 不受
//   影響;宣告 `jobs` 的 manifest 其 coreApi 應宣告 "^1.10.0"(id 重複 / every 非正整數
//   於 defineExtension 時 fail-loud)。
// 1.11.0(docs/spec-declarative-notify-schedule.md:declarative notify + schedule,
//   兩個表面共用此 bump,因為動同一組檔案):
//   - A:declarative `contentTypes[].notifyOnCreate`(optional boolean)。public
//     create(dx/crud.ts POST 的 ct.public 分支)成功後 best-effort 寄通知信,收件人
//     為新 core setting `core.notifyEmail`(空值 = 功能關閉)。email provider 的第一個
//     真 core 消費者(dx/notify.ts)。純新增、可選欄位 → minor bump(§1)。
//   - B:declarative manifest 頂層新增可選 `schedule[]`(≤8;deleteOlderThan v1 op)。
//     interpret.tsx 透過 dx/schedule-jobs.ts 的 buildScheduleJobs() 轉為
//     Extension.jobs,騎在 1.10.0 的 ext-jobs 引擎上執行(零引擎改動,純消費)。
//   manifestSchema(declarative,dx/manifest.ts)是 .strict() —— 宣告 `notifyOnCreate`
//   或 `schedule` 的 manifest 在 <1.11.0 的 core 會整包驗證失敗,故使用這些欄位的
//   manifest 其 coreApi 必須宣告 "^1.11.0"。
// 1.12.0(docs/spec-ai-capability.md:core 統一 AI 呼叫 ai:generate capability):
//   - 新 core 內建 provider(單一 "core" provider,src/ext/providers/ai.ts):設定驅動
//     路由 openai-compatible / anthropic-compatible / Cloudflare Workers AI 三模式,
//     同 email:send 前例(registry 恆註冊 → availableServices() 恆列出
//     "ai:generate";「註冊≠已設定」的既有語意不變——mode:off 或缺 model/apiKey 時
//     generate() 回 { ok:false, error:"not_configured" },永不 throw)。
//   - 新 core settings:core.ai.mode / core.ai.baseUrl / core.ai.apiKey(secret)/
//     core.ai.model(group:"advanced")。純新增、可選欄位 → minor bump(§1)。
//   - workers-ai 模式讀取 Cloudflare `AI` binding(src/lib/cf.ts 的 getAI());binding
//     未宣告(wrangler.jsonc 未加)→ not_configured,不 throw。本次刻意不動
//     wrangler.jsonc —— binding 由使用者自行加(spec 明定,執行期偵測)。
//   - 新 helper src/lib/ai.ts(generateAiText,照 sendEmail 的 activeAiProvider /
//     activeEmailProvider 模式)+ POST /api/ai/generate(admin only + rate limit,
//     測試口 + 未來 UI 掛點,回應為 AiGenerateResult 原樣透傳)。
// 1.13.0(docs/spec-ai-capability.md streaming 附錄:ai:generate v1.1 streaming):
//   - AiProvider 新增選填方法 `generateStream?(opts): AsyncGenerator<AiStreamEvent>`
//     (新型別 AiStreamEvent = delta/done/error)。純新增、選填 → minor bump(§1);
//     未實作 generateStream 的既有/第三方 provider 不受影響——src/lib/ai.ts 的
//     generateAiTextStream() 對缺方法的 provider 退回單一
//     `{type:"error", error:"streaming_not_supported"}` 事件,永不 throw。
//   - CoreAiProvider 三模式(openai/anthropic/workers-ai)皆實作 generateStream,
//     以共用 SSE frame parser(module-level,無新依賴、手刻)解析上游
//     `text/event-stream` 回應。逾時語意與既有 generate() 一致(60s,逾時 →
//     `{type:"error", error:"timeout"}`)。
//   - 新端點 POST /api/ai/generate/stream(admin only + rate limit,與既有
//     /api/ai/generate 共用 "ai-generate" namespace 同一個 10 次/分鐘桶),回應為
//     NDJSON(Content-Type: application/x-ndjson,一行一個 AiStreamEvent)。既有
//     /api/ai/generate 與 generate() 完全不變、仍是主要介面——streaming 是加法。
//   - manifestSchema 未變動(此次不涉及 declarative manifest 欄位),故本次 bump
//     不影響既有 manifest 相容性,單純因為新增 provider 介面方法(§1:新
//     hooks/capabilities/field types → minor;此處是 provider 介面新方法,比照同一
//     精神 minor bump)。
// 1.14.0(docs/spec-payment-capability.md:payment capability + callback Response):
//   - capabilities.ts 新增 PaymentProvider 介面(createCheckout(req) →
//     CheckoutSession union:form-post / redirect / {ok:false,error})與
//     CheckoutRequest 型別。capability = "payment",core 不內建 provider ——
//     由 code extension 以 `provides` 註冊(第一個消費者:extensions/newebpay
//     藍新金流)。純新增介面 → minor bump(§1,同 1.13.0 的 provider 介面前例)。
//   - CallbackReceiver.handleCallback 回傳型別由 Promise<void> 放寬為
//     Promise<void | Response>:回傳 Response 時 ingress 原樣轉發給呼叫端(payment
//     ReturnURL 的瀏覽器 form-POST 需要 HTML 結果頁/303;未來 OAuth redirect 同)。
//     對既有 provider 是嚴格放寬(void 仍合法、行為不變),非破壞性 → minor。
//     安全契約不變:僅 verify 通過後才執行 handleCallback。
//   - 新共用引擎 src/ext/payment-kit/(同批):多金流共用的 provider 引擎
//     (訂單表讀寫/冪等結算/payment:succeeded hook/結果頁)、checkout handler
//     工廠、adminPage 積木與測試付款表單。各金流 extension 只寫
//     PaymentGatewayAdapter(金鑰讀取/加密簽章組包/驗簽/解包)。加密簽章
//     必須是 code(各家 canonicalization 細節不同,不可宣告式化)—— kit 把
//     「接新金流」縮到 ≈ 一個 adapter 檔 + 一個薄 manifest。
// 1.15.0(spec-extension-i18n.md:extension i18n 表面):保留給 declarative
//   extension 的 i18n 字典 / 訊息 key 表面(見該 spec)。此版號在 login-providers
//   落地時尚未實作,但已被 spec 佔用 —— login-providers 故跳過 1.15.0、用 1.16.0,
//   避免與 i18n 撞號(spec-login-providers.md §0 明列)。
// 1.16.0(spec-login-providers.md:declarative 第三方 OIDC 登入):
//   - manifest 新增可選頂層 `loginProvider`(issuer / scopes / button{label,svg,
//     background,foreground})。svg 經新 svg-guard(src/ext/dx/svg-guard.ts,照
//     stylesheet-guard.ts 的 validate-and-REJECT allowlist 哲學)驗證,失敗 =
//     manifest 驗證失敗(fail-loud);background/foreground 沿用既有 themeColorSchema。
//     client id/secret 不在 manifest 宣告,走既有 settings[](clientId text /
//     clientSecret secret:true)慣例,引擎按 `ext.<extId>.clientId` / `.clientSecret`
//     key 直接讀。純新增、可選欄位 → minor bump(§1)。manifestSchema 是 .strict()
//     —— 宣告 loginProvider 的 manifest 在 <1.16.0 的 core 會整包驗證失敗,故其
//     coreApi 必須宣告 "^1.16.0"。
//   - 新 core 引擎 src/lib/oidc.ts:通用 OIDC authorization code flow(discovery +
//     PKCE S256 + id_token 完整驗證 RS256/ES256 via WebCrypto + JWKS),
//     role-agnostic(第三方身分只對應 user 列;role/permission 全走既有機制)。
//   - 新角色 `guest`(SessionUser.role / users schema enum 加 "guest");
//     `requireAuth` 改為「最低門檻」語意(minRole 預設 "editor",既有呼叫點行為
//     不變、guest 自動 403;只有帳號自身端點明確 requireAuth("guest") 放行)。
//   - 新表 user_identities / oauth_states(手寫 migration 0009);新 core setting
//     core.auth.oauthRegistration(guest|off,開放註冊 policy)。
//   - 新端點:/api/auth/oauth/[provider]/{start,callback}、/api/account/identities
//     (+ [id] DELETE,含「最後登入方式」guard)。
//   - 型別/介面新增(guest role、requireAuth 最低門檻、loginProvider 表面)→
//     比照既有「新 field type / provider 介面方法 → minor」精神 minor bump(§1)。
export const CORE_API_VERSION = "1.16.0";
