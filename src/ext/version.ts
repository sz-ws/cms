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
// 1.17.0(spec-extension-i18n.md:declarative extension 使用者可見字串 i18n,
//   Option A —— inline per-locale union):manifest 的使用者可見字串站點(content
//   type label、欄位 label、group/repeater/block label、settings label/description/
//   option.label、adminPage title、dashboardCard title、publicRoute success.message、
//   installPrompts label/description、requires reason、頂層 name/description)由
//   plain `z.string()` 擴成 `z.union([z.string(), localizedString])` —— localizedString
//   為 `{ en?, "zh-Hant"? }` 的 .strict() 物件(refine 至少一鍵)。
//   - back-compat 硬需求達標:純字串 manifest 是 union 的第一分支、一字不改全過,
//     且 render 行為完全不變(現況單語言 = 所有 locale 都用這一句)。
//   - 消費端一律走純 helper resolveLocalizedString(value, locale)(src/lib/i18n/
//     localized.ts):server views 每 request 以 getLocale() resolve;client(admin,
//     有 I18nProvider)以 useLocale();public FormView 由 route 的 server wrapper 傳
//     locale 下去(public 頁無 provider)。interpret 的 memo 凍結點(adminPage title /
//     public form title/success / Extension.name/description / settings 直傳)一律
//     改成「傳原始 LocalizedString、在 per-request 邊界 resolve」,避免 loader 的
//     locale-agnostic memo 把字串凍在某個 locale。
//   - 刻意延後:content-type select `options`(value=label 糾纏,localize 需把
//     string[] 升成 {value,label} —— 破壞既有儲存值語意的較大工程,列 follow-up);
//     registry.json index / Browse 卡(surface B,維持 plain string 英文,v1 不做)。
//   - manifestSchema 是 .strict() —— 但本次「只加聯集、不加新鍵」,故舊 core 對「純
//     字串」manifest 仍全過;只有實際採用「物件形式」翻譯的 manifest 在 <1.17.0 的
//     core 會被 .strict() 的 string 分支拒(舊 core 的 label 是純 string),故使用
//     物件形式者其 coreApi 必須宣告 "^1.17.0";純字串 manifest 不受影響、任何 core
//     版本都過。純新增可選能力 → minor bump(§1)。
// 1.18.0(docs/spec-extension-contract-validation.md:extension contract hardening):
//   - code/declarative SettingField 新增 optional `required`;settings API 依實際 field
//     definition 驗 submitted values(type/finite number/select option/required),錯誤回
//     `{error:"invalid_values",fields:[{key,code}]}`。`textarea` 保留既有 JSON value
//     相容性(registry sources/dashboard insights)。新 optional manifest surface → minor。
//   - declarative manifest install-time fail-loud:settings default/type/options、duplicate
//     content types/fields/settings/prompts/pages/routes、slugField/admin/public/schedule/
//     customApiRoute contentType references、webhook secretSetting、prompt type/secret
//     consistency。既有合法 manifest 行為不變;以前被 silent-skip 的壞 manifest 現在拒絕。
//     同時驗 nested field keys / block names / block field keys;required 必須搭配
//     coreApi >=1.18.0,且 interpret 保留 required 至 runtime SettingField。
//   - code defineExtension 對稱驗 settings/defaults、migrations/admin/public surfaces,
//     並拒絕重複 settings/migration IDs/admin slugs/API routes/provider registrations。
//   - content/install prompt required strings 使用 trim-aware 判定,純空白視為 missing。
//     settings admin 顯示 required marker/aria-required;number 空 input 保留 null,不轉成 0。
//   - declarative install 改為 prepare + 單一 D1 batch:migration DDL/markers、manifest row、
//     defaults、prompted encrypted settings 原子 commit/rollback;hooks/cache 僅 post-commit。
//     更新時禁止既有 setting key 的 type/secret/required/select options contract 改變
//     (作者須新增 key + migration);secret default 必須為空;stale migration marker
//     conflict 令整批 rollback並回 409;已移除 setting rows 同 batch 刪除,避免 stale value
//     在 key 重加時繞過 contract guard;migration array 必須 immutable append-only。
//     declarative enable/disable 亦使用 revision claim;uninstall 原子清除資料與 positional
//     migration markers、保留 revision claims 作 tombstone,reinstall 從最新 tombstone CAS。
//     既有 setting keys 不可移除(避免 settings endpoint stale write)。
//   - core setSettings 同步改為 prepare + atomic D1 batch,settings:saved hook post-commit
//     best-effort,避免 registrySources/tokens 或一般多欄設定部分寫入。
//   使用 `settings[].required` 的 extension 應宣告 coreApi "^1.18.0";只使用舊表面的
//   extension 仍由 caret range 向前相容。
// 1.19.0
//   - 新增兩個 filter hook:`filter:publicHeader` / `filter:publicFooter`,由新的
//     src/app/(public)/layout.tsx 消費,套在所有公開路由外層。兩者預設 null =
//     不渲染,故對既有 extension 完全無影響(純附加)。
//     動機:在這之前,一個站要放自己的頁首頁尾只能改 src/ 底下的 core 檔案,
//     那會讓「把 core 修正 merge 回已交付的站」變成解衝突地獄。有了這兩個 filter,
//     站台外框由 extension 提供,客戶站與正本的分歧維持在零。
//   - 同批(非 CORE_API 表面,但同屬「別人架的站不該被 core 蓋掉品牌」):
//     root layout 的 metadata 改為 generateMetadata() 讀 core.siteTitle /
//     core.siteDescription(以前硬寫 title:"CMS",每個部署出去的站都送
//     <title>CMS</title>);icon.svg / apple-icon.png 移到 (admin)/ —— 產品 icon
//     只代表後台,公開站的 favicon 由架站者自己放(同 Next.js 預設可被覆蓋的語意)。
//   使用 publicHeader/publicFooter 的 extension 應宣告 coreApi "^1.19.0"。
// 1.20.0(內容多語化 —— schema 層;migrations/0011):
//   - `contents` 新增 `locale` 與 `translation_group` 兩個 ROW 欄位:一列一個
//     (entry, locale),同一份內容的各語言版本以 translation_group 相連。兩者
//     **建立後不可變更**(改 locale = 刪除後重建),update() 帶了會 fail loud。
//   - slug 唯一性從 (type) 範圍移到 (type, locale):雙語站可跨語言共用同一個
//     slug,也可逐語言用不同 slug(/about vs /關於)—— 兩種慣例皆合法。
//   - `ContentProvider.getBySlug` 新增第三個參數 `locale?`,`ContentEntry` 新增
//     `locale?` / `translationGroup?`。**三者皆為 optional,這是刻意的**:設成
//     必填會讓既有 provider 實作與手工組出的 entry 全部編不過 —— 那是 provider
//     介面破壞,依本檔頂部規則屬 major。有了 optional 才是 minor。
//   - 新設定 `core.content.defaultLocale`(預設 "en"),與 `core.locale`
//     (那是「管理介面語言」)**刻意分開**:合併會造成管理員切換自己的後台語言
//     就改變匿名訪客看到的內容。
//   - content_fts 同批重建:加 locale 欄,並修掉 CJK 搜不到的既有 bug
//     (unicode61 不對中日韓斷詞,「我們」找不到「關於我們」)。修法在應用層逐字
//     切分 + phrase 查詢,不換 tokenizer —— trigram 需要三字以上,而中文最常見的
//     正是兩字詞。見 src/lib/search.ts 的 segmentCjk。
//   讀寫多語內容的 extension 應宣告 coreApi "^1.20.0";只用舊表面者由 caret
//   range 向前相容,不受影響。
// 1.21.0(公開表單收件語意:submission ≠ draft):
//   - manifest 的 `contentTypes[]` 新增可選 `kind`("content" | "submission")。
//     宣告 submission 的 type 不再被當成「等著發佈的內容」:admin 走收件匣
//     (未讀 / 已讀 / 已封存 + 已回覆紀錄,狀態住新側表 content_submissions,
//     見 migrations/0014 與 src/lib/submissions.ts),沒有發佈鈕、沒有編輯表單、
//     沒有版本歷史(訊息是不可變的,替它留快照只是把同一份內容抄第二遍)。
//   - **向後相容不靠作者改 manifest**:沒寫 `kind` 時走推論 —— `public:true`
//     且整份 manifest 沒有任何 list/detail public route 指向它 → submission。
//     於是 registry 既有的 contact(public + notifyOnCreate + 只宣告 view:"form")
//     一個字都不用改就自動取得收件匣語意。宣告了公開 list/detail 的 public type
//     (公開留言板那種 UGC)推論不成立,行為與 1.20.0 之前完全一致。明寫
//     `kind:"content"` 可退出推論。判定規則只有一份實作:src/ext/dx/submission.ts。
//   - 隱私硬需求(公開面永不外洩收件內容),四層,彼此獨立:
//       1. manifest 驗證:明寫 kind:"submission" 又宣告 list/detail public route
//          → install 當下驗證失敗(fail-loud)。
//       2. interpret:submission type 的 list/detail public route 一律不生成
//          (涵蓋推論而來者,以及手改 DB 繞過驗證的情況)。
//       3. Content API(/api/content/<extId>/<type>):命中 submission type 直接
//          404,在任何查詢之前。
//       4. 結構:submission 列的 status 恆為 'draft'、publish_at 恆為 NULL,而
//          公開 API 強制 filter.status='published' —— 就算前三層全垮也讀不到。
//     另外 src/lib/jobs.ts 的 publish-due 加上 NOT EXISTS 防護,排程發佈永遠碰不到
//     收件列(理由同上:被自動發佈的私人詢問是隱私事故,不能靠推論)。
//   - submission type 的 auto-CRUD 收窄:PUT 回 403 immutable_submission
//     (別人寄來的訊息不該被站方改寫),改以新的 PATCH `<type>/:id/inbox`
//     變更收件狀態 / 標記已回覆;revisions 三條路由不生成。GET/DELETE 不變,
//     所以既有的 schedule[] deleteOlderThan 保留策略原樣繼續生效。
//   - contents 表**一欄未動**(狀態住側表);既有站台不需要任何資料 backfill——
//     側表沒有紀錄的舊提交一律讀為「未讀」。
//   manifestSchema 是 .strict() —— 宣告 `kind` 的 manifest 在 <1.21.0 的 core 會整包
//   驗證失敗,故使用該欄位的 manifest 其 coreApi 必須宣告 "^1.21.0";不寫 `kind`
//   而依賴推論的 manifest 不受影響、任何 core 版本都過。
// 1.23.0(部署端 PBKDF2 校準):
//   - 新 core setting `core.auth.passwordHashing` 是不可分離的 profile：同時保存
//     PBKDF2-HMAC-SHA256 iterations 與同一 work factor 產生的 dummy hash。這讓
//     login 的不存在帳號路徑不會因校準後 dummy 留在 600k 而反向變成列舉 oracle。
//   - setup 與 admin settings 共用可重跑 wizard；browser 以 request 是否完整返回
//     做有限二分 probe，因 Workers 同步執行時 Date.now()/performance.now() 不前進。
//     OWASP 600k 是硬下限，無法存活時明確提示升級 Workers CPU，而非靜默降級。
//   - password hash 本身既有 `pbkdf2$<iterations>$...` 自描述格式，verify 早已讀取
//     每筆 stored iterations；舊 600k 帳號不需資料 migration，之後的新寫入採 profile。
// 1.22.0(媒體服務層 —— 圖片變體):
//   - `/api/files/<key>` 新增 `?w=`(寬度)與 `?f=`(格式)兩個查詢參數,extension
//     組得出來的 URL 契約,故屬 CORE_API 表面。寬度是**封閉白名單**
//     (320/640/960/1280/1920),`?w=` 會被 snap 進去 —— 開放任意值等於讓
//     `?w=1..2000` 的迴圈刷出兩千次計費轉檔並灌爆邊緣快取。
//   - `StoredFile` 新增 `width` / `height`(選填):上傳當下以純 JS parser 從檔頭
//     嗅出並存進 R2 customMetadata(沿用 alt text 的前例,不建表)。刻意不用
//     env.IMAGES.info() —— 上傳是不可逆的寫入路徑,把它綁在一個可選的付費功能上,
//     等於「開通之前上傳的檔案永遠沒有尺寸」。既有物件沒有這兩個值,讀取端視為
//     undefined 並省略 width/height 屬性。
//   - 轉檔走 env.IMAGES binding 而非 /cdn-cgi/image:後者是 zone 層級功能,而
//     DEPLOY.md 帶著人走到的是純 *.workers.dev,那不是 zone,URL 形式不適用。
//     binding 早就宣告在 wrangler.jsonc 裡(從未被使用),故部署者無需新增任何
//     binding。Images 未啟用時原樣回傳原檔(X-Image-Transform: none),永不 404/500。
//   讀 StoredFile 尺寸或組 ?w=/?f= 的 extension 應宣告 coreApi "^1.22.0";
//   舊 extension 不受影響(參數被忽略、欄位為 undefined)。
// 1.24.0(公開站浮層插槽):
//   - 新 filter hook `filter:publicWidgets`,由 src/app/(public)/layout.tsx 消費,
//     值是 `ComponentType[]`,渲染在頁尾之後、不參與版面流。給的是「疊在頁面上、
//     不佔版位」那一類東西:購買通知、cookie 橫幅、回到頂端、客服泡泡。
//   - 為什麼不重用 publicHeader/publicFooter:那兩個的語意是**取代**(值為單一
//     component),而實務上頁尾 extension 幾乎都寫成 `() => MyFooter`、無視傳進來
//     的值。浮層若寄生在 publicFooter,是否活著就由「誰先註冊」決定 —— 一個由安裝
//     順序造成的靜默消失,而且症狀是「東西沒出現」,最難查。所以浮層自己一個插槽,
//     且值是陣列,約定 `(w) => [...w, MyWidget]`:append 沒有順序風險,N 個浮層
//     可以共存。
//   - core **不替浮層加任何容器或 class**。一旦 core 包一層,就等於替所有 widget
//     決定了 stacking context 與 pointer-events,而那正是浮層最需要自己掌握的兩件
//     事。每個 widget 自己 `fixed` 自己的角落與 z-index。
//   - layout 端對 filter 回傳值做防禦:非陣列或非 function 的項目一律略過。外框的
//     失敗模式必須是「少一個浮層」,不是整個公開站白畫面。
//   註冊 publicWidgets 的 extension 應宣告 coreApi "^1.24.0";在更舊的 core 上該
//   filter 沒有消費端,handler 不會被呼叫(不會壞,只是浮層不出現)。
// 1.25.0(progressive 的打包那一半):
//   - 宣告式 manifest 新增可選 `files[]`。在此之前 core-v2 §3.6 只做完了**執行期**
//     那一半:overrides.ts 的 registry 在、interpret 也會查它,但沒有任何辦法把
//     強化層送到站台 —— repo 裡那兩個示範(extensions/blog/layout.tsx、
//     extensions/gallery-enhance/)是**手動**放進去的,而 CLI 對 kind !== "code"
//     直接拒絕。於是 `deployment: "progressive"` 這個列舉值自 1.0 起就存在,卻沒有
//     任何 extension 能真的用它。files[] 補上的就是這條路。
//   - 語意分工刻意不變:宣告式那一半照樣 hot-install(裝完立刻能用泛用版面),
//     files 是**選配**,而且只有 rebuild + deploy 後才點亮。移除檔案就退回 baseline
//     —— 這是 §3.6 的「additive, never a one-way eject」承諾,現在有打包路徑撐著它。
//   - 路徑安全:files[] 的字串會被 CLI 拿去組本機路徑並寫檔,而 manifest 可能來自
//     任何一個被加進 registrySources 的來源。schema 走**白名單**([a-zA-Z0-9._-] 與
//     "/"),再加一道 ".." 段的 refine。CLI 端另有同樣的檢查 —— 兩道互相獨立,因為
//     這兩端會被不同的攻擊面觸及(hot-install 走 core,檔案落地走 CLI)。
//   manifestSchema 是 .strict() —— 宣告 files 的 manifest 在 <1.25.0 的 core 會整包
//   驗證失敗,故使用該欄位的 manifest 其 coreApi 必須宣告 "^1.25.0"。
// 1.26.0(錯誤回報層):
//   - 新 core 模組 `src/lib/observe/`(sentry-options + report)。對外只有兩件事:
//     `reportError(error, tags)`(送出去,絕不 throw、刻意不重複 console.error)與
//     `ensureReporting()`(在這個 isolate 綁好 client 並回報現況)。Extension 介面
//     一個欄位都沒動,所以這是「新 capability → minor」那一類,不是破壞性變更。
//   - 為什麼是 core 而不是純 extension:要涵蓋的錯誤發生在 core 裡 —— src/ext/hooks.ts
//     的 doAction/applyFilters(每個 extension 的 hook 失敗原本都只 console.error,
//     HTTP 照樣回 200)與 Next 的 onRequestError。core 不可能等某個 extension 的
//     程式碼先跑過一次才開始有能力記錄錯誤。
//   - DSN 有兩個來源,設定優先於環境變數:`ext.sentry.dsn`(sentry extension,
//     secret:true,填完存檔即生效)與 `CMS_ERROR_DSN`(wrangler var,module load
//     就綁得起來,所以連「還沒進到我們任何一行程式碼」的請求都收得到)。取捨寫在
//     src/lib/observe/report.ts 的檔頭。
//   - ⚠️ 環境變數**絕不能**叫 SENTRY_DSN:SDK 內部是 `dsn: options.dsn ?? process
//     .env.SENTRY_DSN`,傳 undefined 想關掉它時它會自己回頭去環境變數撿,把整段
//     本機靜音判斷繞過去。理由完整寫在 src/lib/observe/sentry-options.ts。
//   consume `@/lib/observe` 的 code extension 應宣告 coreApi "^1.26.0";更舊的 core
//   上那個模組不存在,是建置期失敗而不是 runtime 降級。
// 1.27.0(extension 設定的 env 覆寫):
//   - `ScopedSettings.get` 現在先查環境變數,查無或空字串才回頭讀 D1 的 settings 表。
//     名稱由 `envKeyForSettingKey()` 推導:`ext.newebpay.hashKey` → `EXT_NEWEBPAY_HASH_KEY`。
//   - 為什麼順序是 env 優先:(a) 12-factor 的慣例就是環境覆寫設定檔;(b) 這是**唯一**
//     能在首次 boot 前配置好的途徑 —— settings 表要 deploy 完才存在,而 `sz-ws-cms add`
//     跑在 deploy 之前,碰不到那個 D1。沒有這一層,CLI 問完設定就無處可寫。
//   - ⚠️ 名稱推導必須與 `cli/src/settings.ts` 的 `envKeyFor()` 逐字元一致。兩邊算出
//     不同的名字 = 寫入時叫 A、讀取時找 B,使用者會看到「設了卻沒生效」且無從查起。
//     test/ext-settings-env.test.ts 用同一組例子把兩邊釘在一起,分家就會紅。
//   - 加 extension 前綴的理由:manifest 的 key 是 extension 內的區域名稱(`apiKey`),
//     而 env 是整個 Worker 的**平坦命名空間**,直取 key 會讓後裝的靜默覆蓋先裝的。
//   - 空字串視為未設而非「設成空」,與 CLI 刻意不把 default 寫進 vars 的決定對齊
//     (否則會產生「看起來設過、其實是佔位值」的欄位,而 preflight 反而放行)。
//   - 型別轉換依 `get(key, fallback)` 的 fallback 型別(boolean/number),轉不動就
//     當作沒設 —— 一個轉壞的值比沒有值更難查。
//   依賴此行為的 extension 應宣告 coreApi "^1.27.0";更舊的 core 上環境變數會被
//   完全忽略、靜默退回 D1,是**沒有錯誤訊息的 runtime 降級**,所以務必宣告。
// 1.28.0(commerce 基座:manual 付款 + 匿名 API 端點,兩個表面同批共用 bump,
//   因為同一個消費者 —— 商店結帳 —— 同時需要兩者):
//   - CheckoutSession 新增第三種 kind "manual"(capabilities.ts):沒有 gateway 的
//     人工收款(銀行轉帳/ATM)。回一組付款指示(ManualInstructionLine[]),結算
//     入口是 admin 人工核帳而非回呼 —— payment-kit 新增 manual.ts
//     (createManualPaymentProvider / settleManual),與 gateway 回呼共用同一段
//     結算(settle.ts 抽出自 provider.ts:冪等條件式 UPDATE + payment:succeeded)。
//     消費端因此不需分辨付款方式。union 加分支對既有消費者是 additive(switch 不
//     處理 "manual" 的舊碼行為不變)→ minor bump(§1)。
//     判斷紀錄:匯款曾考慮放 commerce 側,否決 —— 結帳路口必須統一(commerce 只
//     說「去收錢」),否則每加一種人工收款方式 commerce 都要多學一種;而 kit 的
//     結算/hook 本來就與「錢怎麼進來」無關。加密簽章不是 payment-kit 的準入條件,
//     「擁有付款結果的真相」才是。
//   - ApiRoute 新增可選 `public`(types.ts):code extension 可宣告單一 API route
//     免登入。在此之前 code extension 的 API 一律 requireAuth(editor+),匿名寫入
//     只有 declarative public content type 的 POST 一條路 —— 商店結帳(訪客就是
//     呼叫者)做不出來。dispatcher 對 public route 跳過 requireAuth,但 mutation
//     的 same-origin 檢查**照舊**;rate limiting 由 handler 自理(hitRateLimit)。
//     ctx.user 為 anonymous placeholder(同 declarative public POST 前例)。
//   - payment:succeeded 的 payload 增帶 `orderNo`(settle.ts 統一填入)—— 消費端
//     靠它對回自己的訂單,不必解讀各 gateway 形狀不一的 event。可選欄位,第三方
//     provider 不填仍合法 → additive。
//   - 同批(非 CORE_API 表面):新 src/ext/commerce-kit/(商店引擎:訂單狀態機
//     pending_payment→awaiting_verify→paid→shipped→completed(+cancelled/refunded)、
//     結帳協調、匯款回報/核帳、admin 積木),消費者為 extensions/shop(薄接線)+
//     extensions/banktransfer(第一個 manual provider)。皆不預裝(newebpay 前例)。
//   使用 kind:"manual"、ApiRoute.public 或 hook orderNo 的 extension 應宣告
//   coreApi "^1.28.0";舊 extension 不受影響(union 舊分支、route 預設仍要登入)。
// 1.29.0(docs/spec-admin-agent.md §3:ai:generate v1.2 tool calling):
//   - AiProvider 新增選填方法 `chat?(opts: AiChatOptions): Promise<AiChatResult>`
//     (新型別 AiToolDef / AiChatMessage / AiChatContentBlock(text|tool_use|
//     tool_result)/ AiChatToolUse / AiChatStopReason / AiChatResult,宣告於
//     src/ext/providers/ai-chat.ts 並由 src/ext/providers/ai.ts re-export,對外
//     import 路徑不變)。純新增、選填 → minor bump,比照 1.13.0 的 generateStream
//     前例(§1:新 hooks/capabilities/field types → minor;provider 介面新增選填
//     方法屬同一精神)。
//   - 未實作 chat 的既有/第三方 provider 完全不受影響:src/lib/ai.ts 的
//     chatAiWithTools() 對缺方法的 provider 退回
//     `{ok:false, error:"tool_use_not_supported"}`,永不 throw —— 與
//     「未設定 → not_configured」「未實作 streaming → streaming_not_supported」
//     同一個哲學。
//   - CoreAiProvider 三模式的支援不一致,這是刻意的:openai(function calling:
//     tools→functions、tool_use→tool_calls、tool_result→role:"tool" 訊息)與
//     anthropic(原生 tool use,content blocks 一對一)完整支援;workers-ai 僅部分
//     模型支援,不維護模型白名單(Cloudflare 的模型目錄變動比本 repo 快,白名單
//     只會變成過期的謊言),試打失敗即回 `tool_use_not_supported`。逾時仍回
//     "timeout" 不併入該錯誤 —— 「網路慢」與「模型不支援」是兩件事。
//   - v1 非 streaming(spec §3 明定):tool-use streaming 要拼裝增量 JSON,而 admin
//     agent 是確認制 —— write 提案本來就得停下來等人核可,串流沒有 UX 收益。
//   - 共同慣例全沿用 generate():60s 逾時、上游錯誤摘要截 200 字、錯誤字串絕不含
//     apiKey、設定不全 → not_configured。共用內部件抽至
//     src/ext/providers/ai-shared.ts(純搬移,generate/generateStream 行為零變更)。
//   - manifestSchema 未動(此次不涉及 declarative manifest 欄位),故本次 bump 不
//     影響既有 manifest 的相容性;既有 /api/ai/generate、generateAiText()、
//     generate()/generateStream() 一個字都沒改。
//   consume `chat`(或 src/lib/ai.ts 的 chatAiWithTools)的 code extension 應宣告
//   coreApi "^1.29.0";更舊的 core 上該方法不存在,呼叫端會拿到
//   tool_use_not_supported 而非例外,是**沒有錯誤訊息的 runtime 降級**,所以務必宣告。
// 1.30.0(docs/spec-admin-agent.md §2 表格第二列:code extension 的 agentTools):
//   - Extension 介面新增可選欄位 `agentTools?: AgentTool[]`(types.ts)。宣告了就自動
//     進 agent 的 tool registry(agent-tools-runtime.ts 的第三個註冊來源:enabled
//     code extensions)—— 「裝一個 extension = AI 自動會操作它」對 code extension
//     這一半的實作。純新增、可選欄位 → minor bump(§1)。
//   - **不宣告 agentTools 的既有 extension 零影響**:欄位缺省 = 沒有 tool,registry
//     的另外兩個來源(core 內建、declarative contentTypes 自動生成)行為一字未改。
//   - 命名空間是硬規則,而且驗兩次(defineExtension 於載入期、buildAgentToolRegistry
//     於每次組 registry 時,共用同一個 agentToolIssues):每個 tool name 必須以
//     `<extId>.` 開頭、至少兩段點分小寫、同一個 extension 內不得重複、kind 必須是
//     "read" 或 "write"。前綴的理由與 settings 的 `ext.<extId>.` scoping 相同 ——
//     tool name 是 LLM 唯一的定址方式,沒有前綴就等於允許一個 extension 宣告
//     `shop.orders.verify` 冒名另一個 extension 的動作。違規 = defineExtension throw
//     (1.18.0 的 fail-loud 前例)。
//   - manifestSchema 對 code extension 是 .passthrough(),舊 core 不會拒收帶
//     agentTools 的 manifest,只會**安靜地**忽略它(面板少了幾個 tool、沒有任何錯誤
//     訊息)。所以 defineExtension 另立一條硬規則:宣告 agentTools 就必須宣告
//     coreApi "^1.30.0" 或更新,同 settings[].required 對 1.18.0 的前例。
//   - declarative manifest 這一側**未動**:JSON 裝不下 function,宣告式 extension 的
//     tools 一律走「從 contentTypes 自動生成」那條路(dx/agent-tools.ts),不需要也
//     不會有 agentTools 欄位。故本次 bump 不影響任何既有 declarative manifest。
//   - 同批(非 CORE_API 表面):新 src/ext/commerce-kit/agent-tools.ts —— 第一個消費
//     者。createCommerceAgentTools() 產出訂單的 list/get(read)與 verify/transition
//     (write),由 extensions/shop 接線。write 兩個都**呼叫 kit 既有的 handler**
//     (createTransferVerifyHandler / createOrderStatusHandler),不另開直改 status 的
//     路 —— 「訂單翻 paid 的路徑只有 settleManual → payment:succeeded → hook 這一條」
//     這條 1.28.0 立下的紀律,對 agent 一樣成立。
//   宣告 agentTools 的 code extension 必須宣告 coreApi "^1.30.0"(defineExtension 強制)。
// 1.31.0(docs/spec-admin-agent.md §2:確認卡摘要的 i18n):
//   - AgentTool 新增選填方法 `summarize?(args: unknown, locale: Locale): string`
//     (src/ext/agent-tools.ts;defineAgentTool 同步收這個欄位)。純新增、選填 →
//     minor bump,比照 1.29.0 的 AiProvider.chat 前例。
//   - 為什麼要:確認卡那一行是 admin **按下「確認執行」之前唯一讀到的字**,而在
//     此之前它是由 tool description(寫給 LLM 看的英文)第一句 + args JSON 預覽拼
//     出來的。繁中後台的最關鍵一行字是英文,那是產品缺陷,不是取捨。
//   - `args` 是 **LLM 的原始 input,未經該 tool 的 zod schema 驗證** —— write 在
//     loop 內永不執行(§1.2),所以在提案的時點根本沒有 parse 過。實作必須防禦性
//     讀取(同批附上 `readStringArg(args, key)`),缺欄位要生得出合理字串,**絕不
//     throw**。summarize throw 或回空白時 agent-loop 退回原本的推導版摘要,提案本身
//     不受影響 —— 那是保險絲,不是設計。
//   - **未實作 summarize 的既有/第三方 tool 完全不受影響**:fallback 路徑一字未改,
//     摘要與 1.30.0 產出的完全相同。故不宣告新版號也不會壞,只是拿不到人話摘要。
//   - 同批(非 CORE_API 表面):core 自動生成的三個 write 動詞(dx/agent-tools.ts 的
//     create/update/delete)與 commerce-kit 的 verify/transition 都實作了 summarize,
//     zh-Hant 與 en 各一句;label 走既有的 LocalizedString 解析,依 locale 取值
//     (description 那份仍固定取 en —— 讀者是 LLM,語言不該隨站台設定飄移)。
//     agent-loop 的 AgentChatParams 新增選填 `locale`(預設 "en"),由 /chat route
//     以 agent-prompt 的 resolveLocale()(1.31.0 起 export)解析一次後同時餵給
//     system prompt 與摘要 —— 解析兩次等於留一條「AI 說中文、確認卡是英文」的縫。
//   consume `summarize` 的 code extension 應宣告 coreApi "^1.31.0":更舊的 core 上
//   defineExtension 的 agentToolSchema 沒有這個欄位,而 agent-loop 也不會呼叫它 ——
//   結果是摘要安靜地退回英文推導版,沒有任何錯誤訊息。
// 1.32.0(docs/spec-admin-agent.md §3:tool-calling streaming;§5:面板串流):
//   - AiProvider 新增選用方法 `chatStream?(opts: AiChatOptions):
//     AsyncGenerator<AiChatStreamEvent>`(src/ext/providers/ai.ts)。純新增、選用 →
//     minor bump,完全比照 1.28.0 的 generateStream 與 1.29.0 的 chat:**既有介面
//     一個字都不動**,generate / generateStream / chat 的行為零變更。
//   - 事件只有兩種(ai-chat.ts 的 AiChatStreamEvent):`text_delta` 與 `result`,
//     而 `result` **恆為最後一個事件、且恆會出現**。上游 4xx、逾時、斷流全部收斂成
//     `{ok:false, error}` 的 result —— generator 永不 throw,錯誤紀律與 chat() 一字
//     不差(60s 整體預算、摘要截 200 字、絕不含 apiKey)。
//   - 硬性保證:**chatStream 的 result 與 chat() 對同一個上游回應算出的
//     AiChatResult 完全一致**(有測試對同一份假回應同時跑兩條路比對)。實作因此
//     共用 ai-chat.ts 的 toWireChat / toOpenAiMessages / toAnthropicBlock /
//     normalizeStopReason / parseToolArguments —— 尤其 **wire tool 名的換名規則兩條
//     路一模一樣**,否則 transcript 重送時前後兩次請求的 tool 名會對不上。
//     串流實作住新檔 src/ext/providers/ai-chat-stream.ts(ai-chat.ts 已近 650 行);
//     SSE 的「框」解析從 ai.ts 搬到 ai-shared.ts 共用(純搬移,generate 側零變更)。
//   - **只有 openai 與 anthropic 實作串流**。workers-ai 的 chatStream 退回呼叫一次
//     非串流 chatWorkersAi 並包成單一 result 事件:它的 tool calling 本來就是盡力
//     而為,而使用者該看到的是「沒有逐字長出來,但答案照樣出現」,不是一句
//     「不支援串流」。第三方 provider 完全不實作 chatStream 也合法 —— 呼叫端
//     (src/lib/ai.ts 的 chatAiStreamWithTools)以 chat() 包成單一 result 事件,
//     兩層都沒有才回 tool_use_not_supported。
//   - agent-loop 的 AgentChatParams 新增三個選填欄位:`onEvent`(過程事件:
//     step / text_delta / tool / tool_done)、`chatStream`(串流注入點)、`signal`
//     (client 斷線時步間停止)。**onEvent 省略時 loop 的行為與 1.31.0 逐位元相同**
//     —— 走非串流 chat()、不發事件、outcome 形狀一字未改。onEvent 自己 throw 會被
//     吞掉:顯示層壞掉不准連累一輪已經在跑的對話。
//   - /api/admin/agent/chat 依 `Accept: text/event-stream` 改回 SSE(過程事件 +
//     最後一個 `event: outcome`,payload **就是** JSON 模式的同一個物件)。沒帶那個
//     Accept 的呼叫端行為完全不變,auth / same-origin / rate limit 一律未動。
//   consume `chatStream` 的 code extension 應宣告 coreApi "^1.32.0";更舊的 core 上
//   該方法不存在,呼叫端會安靜地退回非串流路徑(沒有錯誤訊息的降級),所以務必宣告。
// 1.33.0(docs/spec-admin-agent.md §5.1:agent tool 結果的卡片式呈現):
//   - AgentTool 新增選填方法 `display?(result: unknown, locale: Locale):
//     AgentDisplay | undefined`(src/ext/agent-tools.ts;defineAgentTool 與
//     types.ts 的 agentToolSchema 同步收這個欄位)。純新增、選填 → minor bump,
//     完全比照 1.31.0 的 summarize 前例:**未實作 display 的既有/第三方 tool 一個
//     位元都不受影響**,面板照舊只有摺疊的工具清單。
//   - 新表面 `AgentDisplay` 與 `agentDisplaySchema`(新檔 src/ext/agent-display.ts):
//     `{ kind:"proportion", preset, data: ProportionWidgetData }` 或
//     `{ kind:"trend", preset, data: TrendWidgetData }`。兩個資料契約與兩份 preset
//     id 陣列**直接 import 自 src/components/admin/dashboard/widgets/types.ts**,
//     不複製 —— 那個檔因此升格為 ext 表面的一部分,必須永遠維持純型別 + const
//     陣列(它現在會被 worker 端引用,引入 React 會讓 agent tool 的執行路徑載不起來;
//     該檔頭已加上這條註記)。
//   - **為什麼呈現由 tool 宣告,不由模型宣告**:另一條路是給模型一個「畫個圖」的
//     tool,把要畫的數字當參數送進來 —— 那等於讓它把自己寫的字畫成圖表,而圖表
//     最強的一件事就是讓數字看起來像事實。這裡反過來:display() 拿到的是**該 tool
//     自己 run() 剛回傳的結果**,模型從頭到尾碰不到那些數字。它能決定的只有「要不
//     要呼叫這個 tool」,而那本來就是它的職權。
//   - 防禦紀律同 summarize:實作必須防禦性讀取、拿不出東西回 `undefined`、**絕不
//     throw**。agent-loop 對每次呼叫包 try/catch 保險絲,並把產物過
//     `agentDisplaySchema`(段數 ≤12、序列 ≤60、字串 ≤120、`.strict()`);驗不過
//     一律丟掉並 console.error,**不截斷、不修補** —— 半殘的圖表比沒有圖表更誤導。
//   - 三條界線寫進 agent-loop:display 只在 read tool **執行成功且結果未被截斷**時
//     產生;**只搭最後的 outcome 走,不進串流事件**(transcript 由 outcome 組裝,
//     串流是暫態);**write 提案永遠沒有 display** —— 不靠任何 if,而是因為 write
//     在 loop 內根本不執行(§1.2)。
//   - 同批(非 CORE_API 表面):三個新的 core read tool —— `core.stats.overview`
//     (getDashboardData → bar-list)、`core.stats.activity`(getWeeklyActivity →
//     trend-bars)、`core.stats.storage`(getDatabaseStats + D1_QUOTA_BYTES →
//     progress-ring)。三個都復用既有聚合函式,不重寫查詢:dashboard 上的數字與
//     agent 說出來的數字必須是同一個來源。面板端新增 DisplayCard.tsx,渲染一律
//     走 dashboard 既有的 preset 查找表(DashboardWidget),不新增圖表元件。
//   consume `display` 的 code extension 應宣告 coreApi "^1.33.0":更舊的 core 上
//   agentToolSchema 沒有這個欄位、agent-loop 也不會呼叫它 —— 結果是卡片安靜地不
//   出現,沒有任何錯誤訊息。
// 1.34.0(docs/spec-admin-agent.md §3.2:上游 token 用量的接收與落庫):
//   - `AiChatResult` 新增選填欄位 `usage?: AiChatUsage`,以及新型別
//     `AiChatUsage { inputTokens?: number; outputTokens?: number }`
//     (src/ext/providers/ai-chat.ts,由 src/ext/providers/ai.ts 原樣 re-export)。
//     純新增、選填 → minor bump,比照 1.29.0 / 1.32.0 / 1.33.0 的前例:**既有介面
//     一個字都不動**,generate / generateStream / chat / chatStream 的既有行為與
//     既有欄位零變更,不讀 usage 的呼叫端一個位元都不受影響。
//   - **兩個 token 欄位都是選填,而且缺席 ≠ 0**。0 是「上游說這次用了零個」,
//     缺席是「上游沒說」。三家 provider 一律「讀得到才填」,沒有任何一條路徑會補
//     預設值 —— 用 0 當缺席會讓事後的加總把「不知道」算成「沒花錢」,而點數制
//     正是建立在那個總和上。同一條規則貫穿到 DB(ai_usage 的 token 欄位 nullable)
//     與 loop 的聚合(sumUsage)。
//   - 三種 mode 的取法(解析器由 ai-chat.ts export、串流那邊 import,**非串流與
//     串流共用同一份**,同 normalizeStopReason / parseToolArguments 的既有紀律):
//       · openai —— 非串流讀 body 的 `usage.prompt_tokens / completion_tokens`;
//         **串流要主動要**(request 多帶 `stream_options:{include_usage:true}`),
//         usage 在最後一個 chunk(`[DONE]` 之前),而那個 chunk 的 `choices` 是空
//         陣列 —— 解析迴圈因此改成「先讀 usage,再走既有的 choice 檢查」。
//       · anthropic —— 非串流讀 `usage.input_tokens / output_tokens`;串流分兩處,
//         `message_start` 帶 input、`message_delta` 帶**累積的** output,後到的
//         覆蓋先到的(mergeUsage,不是相加)。
//       · workers-ai —— 盡力而為。回應形狀不保證有 usage;有就讀(目前的欄位名與
//         openai 同組),沒有就留白,**不換算、不從別的欄位推**。
//   - 落庫:新表 `ai_usage`(migrations/0017_ai_usage.sql + src/lib/schema.ts 的
//     `aiUsage`),**一列 = 一次上游呼叫**(不是一則訊息 —— agent loop 一則訊息最多
//     打 8 次,那 8 次的成本分開發生)。寫入契約 src/ext/ai-usage.ts:**append-only**
//     (只有 INSERT)、**fail-open**(記不成只 console.error,絕不讓對話失敗)、
//     **絕不記 prompt 或回覆的內容,只記數字**。user_id 無 FK + user_email 反正規化
//     (照 0016 agent_audit 的先例);索引 `(user_id, at)` —— 等值欄在前、範圍欄在
//     後,才吃得到「某使用者某期間的總和」那個查詢。
//   - agent loop:每一次上游呼叫之後記一列,**成功與失敗都記**(失敗的請求一樣
//     花錢),拿不到 usage 時仍然記一列、兩個 token 欄位為 NULL(「打了一次但不知道
//     多少」與「沒打」必須分得出來)。`AgentChatOutcome` 另加選填的 `usage`
//     —— 這一則訊息的總和,給之後的面板用;**這一批不渲染它**。
//   - 這一批**不做**:點數扣抵、預算上限、任何 UI,以及 ai:generate 那條路
//     (generate / generateStream)的用量 —— `AiGenerateResult` 沒有 usage 欄位,
//     接它是另一次 minor bump。
//   consume `usage` 的 code extension 應宣告 coreApi "^1.34.0":更舊的 core 上這個
//   欄位不存在,讀到的永遠是 undefined —— 而 undefined 在這個型別裡的意思是「上游
//   沒回報」,於是降級會偽裝成一份「上游都不給用量」的假資料,沒有任何錯誤訊息。
// 1.35.0: ledger-kit exact units and atomic, replay-safe local D1 reservations.
// Ledger-backed extensions are opt-in; no default registry or core tables change.
// 1.36.0: atomic extension-owned records alongside ledger reservations.
// 1.37.0: opt-in managed commerce delegation and queryable payment receipts.
// 1.38.0: admin sidebar icon tokens for commerce and operations extensions
// (archive, banknotes, bug, chart, clipboard, credit-card, gift, landmark, megaphone,
// receipt, shopping-bag, shopping-cart, tag, truck, wallet). Unknown tokens still
// fall back to the keyword heuristic, so older manifests keep rendering.
// 1.39.0: admin sidebar sections, nesting and custom icons. Extensions may declare
// `menu: { section: "content"|"commerce"|"system", parent: "<ext id>", order }`;
// multi-page extensions fold into one folder, and `parent` nests an extension's
// pages under another's (one level; a missing parent or a cycle falls back to top
// level). `icon` accepts an inline <svg> checked by svg-guard, besides tokens. The
// active nav item is the longest matching path. AiProvider gains optional
// isConfigured(); the Assistant nav entry is hidden until AI is configured.
// All additive: older extensions render exactly as before, except multi-page ones
// now appear as a folder.
// 1.40.0: admin sidebar sections are data, and extension admin pages can declare
// search.
// - The five built-in sections (workspace, content, commerce, shop, system) pass
//   through `filter:adminSections`, so a site can rename, add, reorder them, or set
//   `collapse: "active"` (only the section holding the current page starts open).
//   Items from `filter:adminMenu` may point `section` at any section id, core items
//   included; an unknown id lands in content. Manifest `menu.section` still accepts
//   only content/commerce/system.
// - `useAdminPageTitle()` / `<AdminPageTitle>` give a page its sidebar title, so a
//   renamed item and the page heading agree. Breadcrumbs skip the bare /admin/ext.
// - `adminPages[].search` declares searchable columns (text, phone, date); core
//   draws the search box in the top bar and keeps ?q=&from=&to= in the URL. Pages
//   read it with parseRecordSearch / useRecordSearch and build SQL with
//   recordSearchClauses (ext/record-search.ts). An optional `global` block adds the
//   table to ⌘K (admins only); results open the page with ?open=<key>.
// - commerce-kit exports ORDER_SEARCH_FIELDS and listOrders accepts `search`.
// - <Timeline> renders a record's history (components/admin/Timeline.tsx).
// - Settings gain type "color" (#rrggbb, optional `swatches`): a row of swatches
//   plus a custom picker (components/admin/ColorSwatchPicker.tsx, lib/color.ts).
// - `core.adminAccent` (Settings → General) is the admin accent. Browsers cache it
//   in localStorage and do not ask the server again while the cache exists: an
//   inline boot script in the admin layout sets --admin-accent / --admin-accent-fg
//   before paint, GET /api/admin-accent fills an empty cache, and the settings page
//   (which loads the value anyway) refreshes the cache when it differs
//   (lib/admin-accent.ts). Every accent in core now reads the token, tints via
//   color-mix(). Extensions should use var(--admin-accent) instead of
//   rgb(86,114,228); --accent-blue stays as an alias.
// - <LoadingState> centres a "loading" message under an accent-coloured spinner
//   (<AccentSpinner>, components/admin/LoadingState.tsx); it takes its label as a
//   prop so extension workspaces rendered on public pages can use it too.
// - `statusSets` declares a plugin's record states (label, tone); <StatusBadge>
//   draws them. `filter:statusSets` is the site's slot to rename a state or add a
//   description (admin only; states cannot be invented). Each record can also carry
//   a description per state (record + state, so a note written at one stage is not
//   shown once the record moves on): core table record_status_notes (migration
//   0019), lib/record-status-notes.ts for plugins, GET/PUT /api/record-status/notes
//   { set, id, status, note } for admin pages. A described badge shows a small
//   icon; hovering or focusing it shows the text (ext/record-status.ts).
// - Scheduler heartbeats (cron tick, lazy sweep, core job lastRun) live in the
//   `heartbeats` table (migration 0018, lib/heartbeats.ts) instead of settings, so
//   they no longer move the settings stamp or fire settings:saved every minute.
// - Sentry loads only when a DSN is set: instrumentation moved to
//   src/instrumentation.ts (the root file never ran) and keeps only onRequestError;
//   register() and sentry.*.config.ts are gone; withSentryConfig's automatic
//   wrappers are off (lib/observe/bridge.ts).
// - Admin lists (content collections, inbox, users, extensions) update
//   optimistically; lib/optimistic.ts stableReducer keeps row identity stable while
//   a transition is pending.
// Additive: without the new declarations everything renders as in 1.39.0.
// 1.41.0: dates and times follow the site time zone.
// - Setting `core.timeZone` (Settings → General, default Asia/Taipei). Workers run
//   in UTC, so server-rendered times were 8 hours off in Taiwan and the first
//   client render disagreed with the browser's.
// - lib/datetime.ts is the one adapter: createDateFormatter(locale, timeZone) gives
//   date / dateTime / time / monthDay / format / stamp (CSV) / dayKey / dayStart.
//   Server: getDateFormatter() / getSiteTimeZone() (lib/datetime-server.ts).
//   Client: useDateFormatter() / useTimeZone() and <DateTimeText at={ms} />
//   (components/DateTimeProvider.tsx; the root layout provides the zone), which a
//   server component can render directly. Extensions should use these instead of
//   toLocaleString / toISOString for anything shown to people.
// - Core uses it everywhere it shows a date: dashboard, users, audit log, inbox,
//   revisions, passkeys, API tokens, account, shop and payment order tables,
//   <Timeline>, OG images, the export filename. Date fields now mean a day in the
//   site time zone: a day picked in Taiwan used to display as the day before
//   (fmtDate read it in UTC). Page-search date ranges and publish scheduling use
//   the site's days and hours. relativeTimeWords / relativeTime / renderCell /
//   displayValue / dayInputToMs / msToDayInput take an optional time zone.
// - lib/client-cache.ts: readCached / writeCached / dropCached keep the last
//   response of an extension workspace in memory (browser only, never on the
//   server), so switching back to a page shows it at once and refetches behind it.
// - The admin route loading state is the centred accent spinner (<LoadingState>),
//   the same one extension workspaces show, instead of a top-left skeleton.
// Additive: callers that pass no time zone behave as before, except fmtDate and
// displayValue, which now default to the site default (Asia/Taipei) instead of UTC.
// 1.42.0: switching back to an admin page is instant.
// - next.config staleTimes.dynamic = 30: a page visited in the last 30 seconds is
//   shown from the browser's router cache without a request. Saving anything calls
//   router.refresh(), which clears that cache, so an admin never sees their own
//   change missing; changes made elsewhere show up within 30 seconds.
// - <AdminLink> (components/admin/AdminLink.tsx): next/link that prefetches on
//   hover or focus only. Admin tables, cards, pagination and filters use it; the
//   default prefetched every visible row link again after each refresh, and each
//   prefetch ran the admin layout on the server.
// 1.43.0: the settings page reads in one language, and the admin sidebar
// remembers what was opened.
// - Every core setting's label, description and option label now has en and
//   zh-Hant text (LocalizedString). Descriptions say what the setting changes and
//   what an empty value does; spec references are gone from them. Adds the
//   settings.group.ai / aiDesc messages. General group order: site title, site URL,
//   description, the two languages, time zone, logo, accent colour.
// - Setting fields use a CSS subgrid (label / control / help rows), so two fields
//   side by side keep their controls level when only one has a description.
//   Descriptions moved below the control and are linked with aria-describedby.
// - A boolean setting that was never saved shows its default: robots / sitemap / RSS
//   are on by default but the form showed them unchecked.
// - components/admin/nav-open-store.ts: sidebar groups and folders a person opens
//   or closes are kept in localStorage (cms.adminNavOpen) and survive a reload.
//   Ones never clicked still follow the current page.
// Additive: no manifest or API change.
// 1.44.0: choose the email service, Resend or Cloudflare.
// - ext/providers/email-cloudflare.ts: a second built-in email:send provider (id
//   "cloudflare") that sends through the Worker's send_email binding named EMAIL
//   (Cloudflare Email Service). No API key; a missing binding or from address
//   returns not_configured, a thrown error's code (E_SENDER_NOT_VERIFIED, …) goes
//   into detail. core.emailFrom's "Name <addr>" is split into { name, email }.
// - core.provider.email:send (the registry's existing switch) is now a setting on
//   the Email card, drawn as tabs with each service's mark; core.resendApiKey only
//   shows while Resend is chosen.
// - SettingField gains showWhen { key, equals } (hide a field unless another field
//   has a value; the value is still kept) and, for select, presentation: "tabs"
//   with per-option logo (a site image path) and description (shown under the tabs
//   for the chosen option). Code extensions can use both; declarative manifests
//   cannot yet.
// - validRecipients() in ext/providers/email.ts is shared by both providers.
// - A secret field says it is set only when a value is stored; before, every secret
//   field showed "set — type to replace" even when empty.
// Additive: sites that never set core.provider.email:send keep sending via Resend.
// 1.45.0: enabling a code extension, or applying its update, shows each step.
// - Enabling is four exported steps in manager.ts: enableStepCheck (compatibility
//   and dependencies; returns the migrations still to run), enableStepMigrate (one
//   migration), enableStepSettings (defaults for new settings; returns how many),
//   enableStepRecord (version, caches, ext:enabled). PATCH /api/extensions/<id>
//   with action "enable-step" runs one of them, so the admin calls them in order and
//   shows each result; every step is a whole request. enableExtension(extId,
//   onStep?) still runs all four for other callers and reports EnableStepEvent.
//   A core API mismatch now returns 409 with the reason instead of a bare 500.
// - manager.pendingCodeUpgrades(): enabled code extensions whose code version
//   differs from the stored one or that have migrations not yet applied. A deploy
//   ships new code but migrations only run on enable, so until someone applies the
//   update the extension's pages can fail on missing columns.
// - /admin/extensions marks those rows (from → to, 「待套用更新」), adds an
//   「套用更新」 action (enable again: applied migrations and existing settings are
//   skipped, so a retry after a failure is safe), and puts a notice at the top when
//   an update carries migrations. Enable and apply-update draw a step list with
//   waiting / running / done / skipped / failed and the reason on failure.
// 1.46.0: an extension page can replace another extension's page.
// - AdminPage.replaces: ["<extId>"] (that extension's main page) or
//   ["<extId>/<slug>"]. While the replacing extension is enabled, the replaced page
//   leaves the sidebar (a folder then opens on its first remaining page) and its URL
//   redirects to the replacement with the query string kept.
// - ext/admin-menu.ts: adminPageHref() and replacedAdminPages() (chains followed,
//   cycles, self-references and malformed refs ignored). The page route
//   /admin/ext/[extId]/[[...page]] does the redirect.
// - Use case: shop-operations replaces shop's order list and payment queue, which
//   only a site plugin used to hide. Code extensions only; declarative manifests
//   cannot declare it yet.
// 1.46.1: SettingsWorkspace keeps its memoization again (CI was red on lint).
// - 1.44.0 called isSettingVisible(field, keyPrefix, state) from the render to
//   apply showWhen. Handing a value read from state to a function in another
//   module makes the React Compiler treat that state as possibly mutated later,
//   so it drops every useMemo in the component and
//   react-hooks/preserve-manual-memoization errors. The two-line comparison now
//   lives in the component and the helper is gone; behaviour is unchanged.
// - Rule of thumb for admin components: keep values read from useState inside
//   the file. Passing props or constants across modules stays fine.
// 1.47.0: a shared admin style, under Settings → Style (/admin/settings?tab=style).
// - core.adminTheme (versioned JSON: background, surface, ink, radius, elevation,
//   font) sits next to core.adminAccent. /api/admin-theme reads both (any signed-in
//   user) and writes both in one batch (admins, same origin). The schema rejects
//   unknown keys, non-hex colours, dark surfaces and text under 7:1 contrast.
// - Paper & Ink, the default, is the admin exactly as before: only the accent is
//   written. Any other value marks <style id="cms-admin-theme" data-themed>, which
//   turns on the token bridge in app/admin-theme.css and the `admin:` variant.
//   The bridge follows the :root recipe (black at each opacity → the text colour),
//   and Soft depth keeps every component's own shadow.
// - Tokens for admin pages: bg-surface, text-ink, --admin-radius-scale and
//   --admin-shadow-card/panel. Always pass the original value as the var()
//   fallback, because under Paper & Ink these variables do not exist. Shared
//   components keep their public classes and add `admin:` overrides. Semantic
//   shadows (error rings, selection rings, checkbox borders) do not use the tokens.
// - Fonts: a whitelist (ADMIN_FONTS) of Google Fonts, loaded only once chosen.
// - Sidebar icons: Heroicons 16 solid (default) or Lucide outline (icons field).
//   Every icon token maps to both sets, so manifests keep working.
// - The accent is server-rendered CSS scoped to body:has([data-admin-surface])
//   instead of a localStorage cache; AdminAccent, its boot script and
//   GET /api/admin-accent are gone. Saving a style does not refresh the route.
// - SaveBar is shared by the settings form and the style editor (hidden = inert),
//   SettingTabs gains labelStyle and layout: "list", and ColorSwatchPicker's
//   labels are translated.
// Additive for extensions: pages only change if they opt into the tokens.
// 1.48.0: declarative manifests can add scripts to public pages (manifest.scripts).
// - Each entry is either `src` (https, loaded async, host written out in full) or
//   `inline`, plus the `domains` it talks to. Up to four entries.
//   `{{settings.<key>}}` fills in one of the extension's own non-secret settings:
//   URL-encoded in src, a JSON literal (quotes, $, <, /, * escaped) in inline code.
// - Scripts only run after an admin approves them. The approval is the SHA-256 of
//   the scripts, stored in declarative_extensions.scripts_approval (migration 0020)
//   with who and when. Changed content means a new review; the widget re-checks
//   the hash on every render.
// - POST /api/registry/install takes approveScripts; without a matching approval it
//   answers 409 scripts_review_required (or scripts_changed) with the hash.
//   GET /api/registry/manifest returns scripts: { hash, allowed, approved }.
//   GET/POST /api/extensions/<id>/scripts shows, stops and re-approves them.
// - A registry source only offers scripts once allowScripts is set on it
//   (core.registrySources); installs from other sources get 403 scripts_not_allowed.
// - Scripts render through filter:publicWidgets, so they never reach admin pages.
// - Inline scripts can also take data, filled in on the server as JSON literals:
//   {{content.<type>}} is published content (own types: {id, slug, data}; another
//   extension's <extId>.<type>: {id, slug, title} only; inbox types never), and
//   {{feed.<extId>.<name>}} is a code extension's Extension.publicFeeds entry.
//   Each value is capped at 32,000 characters; a failed source is null. The
//   approval covers the template, so new data does not need a new approval.
// - Extension.publicFeeds: name → loader for public data. The shop's
//   recentPurchases returns product name, other-item count and time only.
// - <html lang> follows core.locale instead of a fixed "en".
// - New sidebar icon token "folder".
// Additive: manifests without scripts are unchanged; ones with scripts need
// coreApi ^1.48.0.
// 1.49.0: the product catalog is part of commerce-kit instead of a registry plugin.
// - src/ext/builtin-declaratives.ts: declarative manifests the base ships itself. The
//   row still lives in declarative_extensions (same id, same content types, so every
//   reader is unchanged); the loader reconciles it on each full load and whenever the
//   switch changes: created or replaced with the base's manifest when wanted,
//   disabled (row and content kept) when not.
// - catalog (catalog.product, catalog.category) is wanted while the shop is enabled
//   and its new setting ext.shop.catalog is not false. Its version is CORE_API_VERSION.
// - Built-in ids are refused by POST /api/registry/install (409 builtin_extension)
//   and by enable/disable/uninstall on /api/extensions/<id>; the store index and the
//   extensions page leave them out.
// - lib/settings getPlainSetting(): reads a non-secret setting without building the
//   extension runtime (the loader uses it).
// Additive for extensions reading catalog.product; shop 0.5.0 needs coreApi ^1.49.0.
// 1.50.0: one release — returns in commerce-kit (退貨管理), custom staff roles
// (角色與權限), plugin identity with plugins that require plugins, and an enforced
// CSP on public pages.
// Returns (commerce-kit):
// - returns.ts: the return lifecycle requested → approved / rejected / cancelled;
//   approved → received / refunded / cancelled; received → refunded / completed;
//   refunded → completed (RETURN_TRANSITIONS, no cycles, so "<return_no>:<status>"
//   is each step's idempotency key). RETURN_STATUS_SET is the status set
//   "<extId>:returns"; reasons and refund methods are fixed codes with labels in the
//   dictionaries (returns.reason.*, returns.method.*).
// - returns-engine.ts: createReturnsEngine(db, { ordersTable, prefix }, stock?). A
//   return belongs to a shipped or completed order and snapshots its lines; it never
//   changes the order's own state machine, so managed orders need no new path. Every
//   write is one ledger-kit transaction: the row, its history event, and on "received"
//   the restock, with in-batch guards for the status, returnable quantities (open
//   returns per product never exceed what was ordered) and the refund total (never
//   above the order total). fullyReturned(orderNos) names the orders whose every item
//   is already in a return that is not rejected or cancelled (the same rule as the
//   returnable quantities), so an order screen can drop "start a return"; create()
//   rejects such an order with qty_exceeds.
// - Restock goes through the "inventory" capability, provider id "inventory", shaped
//   as RestockProvider { prepareRestock(sku, qty), getBalance(sku),
//   getReservation(sku, reservationId) } with SKU = product id. Only what the order
//   actually took out of stock goes back: the order's reservation
//   orderStockReservationId(orderNo, productId) = "<orderNo>:<productId>" must be
//   captured (stock_not_taken otherwise), so orders that never touched stock (legacy
//   checkout, placed before inventory) cannot create phantom stock. Without the
//   provider, receiving a return only records; an item with no stock account cannot
//   be restocked (stock_untracked) rather than silently opening one.
// - Refunds are recorded only (amount, method, note). Nothing is sent to a gateway.
//   suggestedRefund(order, items) is the default amount: the items' price scaled by
//   the order discount, (subtotal − discount) / subtotal, shipping excluded.
//   refundCap(order, items) is the ceiling for both the requested amount (create) and
//   the recorded refund (transition): the returned items' unit price × qty plus the
//   order's shipping, never above total − refunded. orderShipping(order) = total −
//   (subtotal − discount), the checkout formula read backwards. Items not being
//   returned don't count, so returning one NT$150 item from an order with NT$150
//   shipping caps at NT$300, not the order total (amount_exceeds); the suggested
//   amount stays the items' paid price. The return detail payload's order carries
//   subtotal and discount so the admin sheet can show the same cap.
//   orderReturnBlock(status) tells a not-yet-shipped order (order_not_returnable) from
//   a cancelled or refunded one (order_closed).
// - returns-api.ts: createReturnsApiRoutes(config) adds GET returns/order/:orderNo,
//   GET returns/:returnNo, POST returns, POST returns/:returnNo/status. Admin only
//   (RETURNS_ROLE), stricter than the dispatcher's editor default; errors are
//   { ok: false, error: <ReturnErrorCode> }, 503 not_ready before the tables exist.
//   shop maps the four routes to its returns page (accessAs "shop/returns"), so a
//   custom role needs 退貨管理 to read (View) or change (Edit) returns.
// - UI: returns-admin.tsx (ReturnsAdminPage, server) renders ReturnsWorkspace (list,
//   status pills counted under the current search, create sheet, detail sheet with
//   next step and history; ?open=,
//   ?order=). StartReturnLink and CommerceOrdersTable's returnsPage prop open
//   "new return" from an order.
// - New sidebar icon token "return".
// Additive. shop 0.6.0 declares it (migration 0004_returns, admin page returns,
// status set shop:returns) and needs coreApi ^1.50.0.
// Staff roles (/admin/roles, System section):
// - admin / editor / guest stay as the three presets and behave exactly as in 1.49.0.
//   A site can add its own roles (accounting, order desk, marketing…): each grants
//   None / View / Edit per admin page. The rows come from the admin sidebar itself
//   (core + enabled extensions + filter:adminMenu), grouped by sidebar section, so a
//   new extension's pages show up on their own and start at None. Settings, users,
//   roles, extensions and the assistant stay admin-only.
// - Storage: staff_roles (migration 0021) with access = { "<admin path>": "view" |
//   "edit" }; users.staff_role_id points at one. Assigning a custom role writes
//   users.role = "guest", so a missing role falls back to the lowest access.
//   DELETE /api/roles/<id> turns its members into guests in the same batch.
// - A custom role only narrows: inside the pages and APIs it is granted it runs as
//   an admin (SessionUser.role === "admin", so extension handlers that call
//   requireAuth("admin") keep working); everywhere else it is a signed-in editor-level
//   user and requireAuth("admin") fails. SessionUser.staffRole ({ id, name }) marks
//   it; isFullAdmin(user) asks for a real admin. getSessionAccess() returns the
//   out-of-scope user plus the access map.
// - Doors (lib/access-scope.ts): /admin/ext/<id>/<slug> and /admin/media check View
//   (404 otherwise); /api/ext/<id>/... checks View for GET and Edit for writes (403
//   otherwise) and runs the handler in that scope, public routes included (a custom
//   role without access is an ordinary member there); /api/media browse/upload need
//   View/Edit on Media or Edit anywhere, alt/delete need Edit on Media;
//   /api/record-status/notes follows the status set's extension (any of its pages);
//   ⌘K search only returns pages the role can view; the dashboard sends a role
//   without it to its first page. Headers are never trusted for this.
// - AdminPage.accessAs / ApiRoute.accessAs: "<extId>" or "<extId>/<slug>" — which
//   page's access a hidden detail page or an API route follows. Declarative edit pages
//   follow their collection page and each content type's CRUD follows the page that
//   shows it (the relation picker's options route excepted). A route without accessAs
//   follows the highest level on any page of its extension.
// - The sidebar only lists what the user can open: editors see the dashboard (the
//   only page their requireAuth allowed), custom roles see their granted pages.
// - lib/admin-nav.ts: buildAdminMenu / buildAdminSections / getFullAdminNavGroups,
//   moved out of admin/layout.tsx so the roles page shares the sidebar's menu.
// - Users page: a role picker per member lists the presets and the custom roles;
//   /api/users takes staffRoleId (PATCH, POST) and returns it (GET).
// - withinAdminPage(pageRef, fn) (lib/access-scope.ts): narrows the current door to
//   one page for the code inside fn — for a route that serves several pages (one
//   actions route that verifies payments and ships orders) and for a provider that
//   re-derives its actor with requireAuth("admin"). Only narrows: the role needs the
//   outer door's level on that page too; without an outer door it is closed; presets
//   are unaffected. Example: an order plugin whose order page and payment page share
//   one API maps each action to its page, so the two pages stay separately grantable,
//   and narrows its commerce:orders transition() to its order page.
// - adminPageLevels(user, { name: pageRef }) (lib/access-api.ts): the caller's level
//   per page, so an API can tell its screen which write buttons to draw.
// - canEditCurrentPage() (lib/access-guards.ts): false for a custom role with only
//   View on the page being rendered. Declarative collection, form and inbox pages use
//   it: no create / bulk / save / restore / inbox actions for view-only roles.
// - Rollout: apply migration 0021 before deploying this Worker. Until it is applied
//   the session lookup ignores custom roles (everyone gets users.role, logged once)
//   instead of failing every signed-in request; the users and roles pages still need
//   the migration.
// Known limits: a grant covers everything the handler does, including calls into
// another extension's provider that authorizes with requireAuth("admin") — such a
// provider runs as admin for the calling route's grant unless it narrows itself with
// withinAdminPage (longer term: pass the actor to providers explicitly). Code
// extensions' own admin screens still draw their write buttons for view-only roles
// (the API answers 403) until they read canEditCurrentPage() or return their levels.
// Additive: extensions without accessAs behave as before for presets; custom roles
// fall back to the extension-wide level.
// Plugin identity and requirements:
// - manifest.identity / Extension.identity: "<publisher>/<name>" (ext/plugin-ref.ts
//   says why this over a UUID). The site-local key is still id. Once a declarative
//   plugin is installed its identity is fixed: POST /api/registry/install answers
//   409 identity_mismatch when an install or update carries a different identity or
//   drops it. A plugin installed before 1.50.0 has none; an update from a different
//   source than the stored one answers 409 source_changed unless the body carries
//   confirmSource equal to that stored source (the store asks first). The identity
//   is read from the stored manifest; there is no new column.
// - manifest.requiresExtensions: [{ id, identity?, optional?, reason? }]. A
//   non-optional one that is not installed and enabled (or is a different plugin
//   under the same id) blocks install with 409 missing_extensions { missing: ids }
//   and blocks enabling (409, names in the message). Both fields need coreApi
//   ^1.50.0. ext/installed-plugins.ts lists what is installed for all three checks.
//   The enable write carries the check in its own SQL (code-lifecycle's
//   requiredPluginsEnabled), like writeCodeEnabled. Disabling or uninstalling a
//   plugin (either kind) that an enabled declarative plugin requires non-optionally
//   now answers 409 naming that plugin; the write carries the same check
//   (noDeclarativeDependents), and uninstallDeclarative disables first.
// - The registry index reads identity and requiresExtensions for both kinds (a code
//   entry may list plain ids, as in Extension.requiresExtensions). GET
//   /api/registry/index marks an entry installed only when it is the same plugin
//   (identity when both the entry and the installed plugin have one, otherwise the
//   stored source; plugin-ref's listingVerdict); otherwise conflict is
//   "identity" | "source" | "kind". An entry without an identity is never
//   "identity": indexes lag manifests. It also returns installedPlugins, and a code
//   plugin compiled into this site fills in its own requiresExtensions when its
//   index entry has none.
// - Store detail lists required plugins with their state and reason, opens a
//   listed one, shows which listed plugins need this one, and replaces the install
//   button while something is missing. The installed list flags plugins whose
//   required plugins are missing or disabled.
// Additive: manifests without the new fields are unchanged.
// CSP on public pages:
// - CSP: public pages get an enforced Content-Security-Policy from src/middleware.ts
//   with a per-request nonce (Next picks it up from the request header, the scripts
//   widget puts it on approved inline scripts) and script-src hosts from approved
//   declarative scripts (src hosts + domains; lib/public-csp.ts). Only script-src,
//   object-src, base-uri and frame-ancestors are enforced; the full policy stays
//   Report-Only. Admin, login, setup and /api keep the old Report-Only policy, and
//   so do files the middleware sees (a known extension such as .txt, .xml, .svg;
//   a page path may contain a dot). The allowlist is memoised per isolate behind a
//   version stamp of declarative_extensions. The Worker variable
//   CMS_CSP=report-only turns enforcement off. lib/csp.ts builds every policy;
//   ext/dx/scripts-core.ts holds the zod-free script helpers.
// 1.51.0: a compiled-in layer can replace a declarative plugin's scripts.
// - New override surface "public:scripts" (surfaceIds.publicScripts(), view
//   "scripts"), one per extension: surface ids may now have two segments
//   "<kind>:<view>" for extension-level surfaces. Props: ScriptsSurfaceProps
//   { extId, settings, data, locale } — settings are the {{settings.*}} values the
//   scripts use (defaults when unset), data is each {{content.*}} / {{feed.*}} ref
//   keyed by its path ("content.sample"), resolved by the same resolver as the
//   scripts (scriptInputsResolver: same feed timeout, 50-entry and 32,000-character
//   caps, a failed source is null) and passed through the same JSON round trip
//   (scriptValue), so a client component can be registered directly.
// - dx/scripts-widget publicScriptsWidget(): when the manifest has scripts and the
//   plugin's enhancement layer registered public:scripts, filter:publicWidgets gets
//   a server component that resolves the inputs and renders it. No <script> from
//   the manifest is emitted and no approval or allowScripts source is needed.
//   Without an override nothing changes.
// - dx/scripts-compiled scriptsCompiledIn(id) drives every script gate: install and
//   update skip scripts_not_allowed / scripts_review_required and clear the stored
//   approval; GET /api/registry/manifest returns scripts: null; POST
//   /api/extensions/<id>/scripts { action: "approve" } answers 409
//   scripts_compiled; the store index marks the entry scriptsCompiled and the store
//   detail and the installed list show 已編進網站，前台不需要 script。 instead of
//   the review. The loader clears an approval left from before the layer was
//   compiled in on its next full load, so lib/public-csp.ts (which only sees
//   approvals) never allows hosts of replaced scripts.
// - To use it: ship files/ with the declarative manifest (1.25.0) whose index.ts
//   calls overrideRegistry.register(id, surfaceIds.publicScripts(), "scripts",
//   Component) guarded by has(), keep the scripts as the fallback for sites that
//   only install from the store, and declare coreApi ^1.51.0.
// Additive: manifests and sites without the layer behave as in 1.50.0.
// 1.52.0: paid extensions, stage 1 (registry protocol 1: prices shown, no payments),
// screens that follow the viewer's access, and plugin numbers on the dashboard.
// Paid extensions (registry protocol 1):
// - Every registry request from core and the CLI carries X-Registry-Protocol: 1. A registry
//   that sees it lists extensions this key has not been given and answers 402 for their
//   manifests and files; requests without it get the old behaviour.
// - Index entries: access ("granted" | "locked" | "requested" | "expired", set per key by the
//   registry) and offer ({ price?: { amount, currency, period: once|month|year }, note? ≤ 40
//   characters, action?: request|link, url?, termsUrl? }, https URLs only). An offer counts
//   only next to access; one that breaks any rule is dropped whole. lib/registry-offer.ts
//   parses and formats (en locale: NT$25,000, $12.50). lib/registry-text.ts strips ANSI,
//   control and bidi characters from registry text; cli/src/registry-text.ts is the same
//   function, held equal by a test. support.url must be https; support.email is read.
// - lib/registry-client: RegistryHttpError { status, code, detail } for non-2xx answers
//   (detail = the body's message, sanitised, ≤ 200 characters). Path-variant loops stop at
//   the first answer that is not 404 and try the variant that worked for a source first.
//   SourceFetchError carries status. registryErrorResponse(e) maps 402 to 402
//   { error: "not_entitled", message? } and 401/403 to 502 source_key_invalid; GET
//   /api/registry/manifest and POST /api/registry/install use it instead of 502
//   manifest_fetch_failed.
// - (source, id): installVerdict / listingVerdict treat another source as source_changed even
//   when identities match, so an update from another source needs confirmSource and GET
//   /api/registry/index marks such listings conflict "source".
// - Store: an entry this key has not been given shows its price and "Contact provider"
//   (support.url, else mailto:support.email) instead of Get; installed ones show Installed with
//   no update; the detail page adds Provider (source host) and Terms. Source errors read in
//   plain words. Entries without access render exactly as before.
// - CLI: add exits 11 (NOT_ENTITLED) when access is not granted or a file answers 402.
// Not yet: in-site requests, action "link", expiry display, notices.
// Screens follow the viewer's access:
// - commerce-kit screens no longer draw buttons the API answers with 403: ShippingEditor
//   and PromosAdmin take readOnly (fields disabled; no add, delete, reorder or save; the
//   shipping preview still runs); TransferVerifyQueue and CommerceOrdersTable draw no
//   order actions without actionsEndpoint (the table's action column shows while it has
//   actions or returnsPage); ReturnsAdminPage reads canEditCurrentPage() and passes
//   canEdit to ReturnsWorkspace and ReturnDetailSheet: no 新增退貨, no ?order= create
//   sheet and no next-step form for a role with View only.
// - commerce-kit/admin loadFullyReturned(config, orders): the shipped or completed orders
//   whose every item is already in a return that is not rejected or cancelled (returns
//   engine fullyReturned; a returns table that is not applied yet counts as none).
//   CommerceOrdersTable's returned prop shows 商品都已申請退貨 for them instead of
//   StartReturnLink. Callers pass returnsPage only to roles with Edit on the returns page
//   (adminPageLevels), as shop 0.6.1 does.
// - Dashboard (components/admin/dashboard/viewer.ts, dashboardViewer(access)): a custom
//   role sees only the cards and numbers whose source page it can open.
//   getDashboardData(viewer) keeps the declarative types whose list page is viewable
//   (type cards, recent entries, totals, distribution); DashboardTypeStats.canCreate
//   (Edit on that page) gates 新增 and quick create; the user count is not queried and
//   not shown; getWeeklyActivity(now, typeKeys) counts only visible types; storage
//   follows the media library; database usage stays admin-only; a role that sees nothing
//   gets dashboardEmpty.noAccess instead of the install-an-extension empty state.
// - resolveDashboardCards(exts, locale, { hrefs, canOpen }): extension cards (declarative
//   and code) link to the page that lists their type (DashboardData.collectionHrefs from
//   the type directory; a type not in it falls back to /admin/ext/<extId>), so edit links
//   for types listed on a sub-page are right, and a card whose page canOpen refuses is
//   skipped before its query.
// - Code extensions close the 1.50.0 known limit by reading canEditCurrentPage() or
//   returning their levels from adminPageLevels, and declaring accessAs on every route.
//   Presets have no access map and see every screen as in 1.51.0. On the dashboard the
//   preset editor (工作人員) is filtered like a role that can open only the dashboard
//   (dashboardViewerFor), so it no longer sees cards or numbers from pages it can't open.
// Plugin numbers on the dashboard:
// - Extension.dashboardStats(ctx) => Promise<DashboardStat[]> (types.ts). ctx: { now,
//   timeZone (core.timeZone via getSiteTimeZone, Asia/Taipei when unset), locale, canOpen
//   (dashboardViewer's; presets allow every href) }. DashboardStat: { id
//   ^[a-z0-9][a-z0-9-]{0,40}$, title: LocalizedString ≤ 60, href: an /admin path with an
//   optional query, value: finite number, display?: string ≤ 24, hint?: LocalizedString
//   ≤ 80 }. defineExtension checks it is a function.
// - dx/dashboard-stats.ts collectDashboardStats: each extension's call is isolated — a
//   throw, a non-array answer or no answer within 2 s (DASHBOARD_STATS_TIMEOUT_MS) drops
//   that extension's numbers with one console.error; the dashboard still renders. Entries
//   are checked one by one: a bad one is dropped with a log line, a repeated id keeps the
//   first, at most 12 per extension, and an href canOpen refuses is dropped silently.
// - resolveDashboardCards(exts, locale, { ..., now, timeZone, statsTimeoutMs }) turns them
//   into kind "stat" cards after that extension's dashboardCards: count = value, plus
//   statId, display and hint; contentType is absent on these (now optional).
// - ExtStatCard shows display when given, else the value through StatNumber with the
//   admin locale (StatNumber takes locales); the hint replaces the extension name; the
//   link reads dashboard.extStat.view (View / 查看) instead of a hard-coded "View all".
// Additive: registries, extensions and roles without the new fields behave as in 1.51.0.
export const CORE_API_VERSION = "1.52.0";
