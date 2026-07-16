-- declarative 版 contact:把 contact 改寫成 contentType-based(寫進共用 contents 表,跟 gallery 同層)。
-- 與舊 forms 版差異:
--   舊:forms section + form:submitted hook → 寫 form_submissions
--   新:contentTypes submission → 走現成 auto-CRUD /api/ext/contact/submission
--     on:"content:created" 觸發 webhook(過濾 type===contact.submission)
-- 匿名提交路徑仍在 client shell(PublicFormView,form:"form" view 還沒做),
-- 改成 POST 到 auto-CRUD。dev e2e 端:到 /admin/ext/contact/submission CollectionView 看。
--
-- 跑:pnpm exec wrangler d1 execute cms-db --local --file scripts/seed-contact-declarative.sql
INSERT OR REPLACE INTO declarative_extensions (id, manifest, version, enabled, source, installed_at, updated_at)
-- coreApi 已從 ^1.3.0 升到 ^1.6.0:manifest 現在帶 dashboardCards(roadmap #16),
-- 而該欄位需要 core 1.6.0+(strict schema,舊 core 會整包拒絕)。dashboardCards 示範
-- 兩種卡:submission 的總數(stat)+ 最近 5 筆提交(recent),都會出現在 /admin 儀表板
-- 的「From your extensions」區塊。
VALUES ('contact', '{"kind":"declarative","id":"contact","name":"Contact","version":"1.0.0","coreApi":"^1.6.0","description":"Declarative public contact form (name/email/message). Anonymous POST goes through the declarative public content API and stores entries in shared contents as type=contact.submission.","contentTypes":[{"name":"submission","label":"Contact submissions","slugField":"email","public":true,"fields":[{"key":"name","type":"text","label":"姓名","required":true},{"key":"email","type":"text","label":"Email","required":true},{"key":"message","type":"text","label":"訊息","required":true}]}],"adminPages":[{"slug":"","title":"Contact submissions","view":"collection","contentType":"submission","layout":"table"}],"publicRoutes":[{"pattern":"/contact","view":"form","contentType":"submission","success":{"message":"收到你的訊息了,我們會盡快回覆,謝謝!"}}],"dashboardCards":[{"kind":"stat","contentType":"submission","title":"Contact submissions"},{"kind":"recent","contentType":"submission","title":"Latest messages","limit":5}],"on":{"content:created":[{"action":"webhook","url":"https://hooks.example.com/REPLACE_WITH_YOUR_ENDPOINT","secretSetting":"webhookSecret"}]},"settings":[{"key":"webhookSecret","label":"Webhook 簽章密鑰","type":"text","default":"","secret":true}]}', '1.0.0', 1, 'manual-seed-declarative', 1750000000000, 1750000000000);
