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
export const CORE_API_VERSION = "1.26.0";
