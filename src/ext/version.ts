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
export const CORE_API_VERSION = "1.32.0";
