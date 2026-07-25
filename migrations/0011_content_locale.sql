-- 內容多語化(locale + translation_group)+ content_fts 重建(locale 欄 + CJK 可搜)。
--
-- 手寫(非 drizzle-kit 產生),照 0006–0010 的 precedent。drizzle journal
-- (migrations/meta/_journal.json)停在 0004,0005 之後全是 out-of-journal 加入的,
-- 所以 `drizzle-kit generate` 會吐出撞號的 "0005_*"(而且它在 package.json 已停用)。
-- `wrangler d1 migrations apply` 依檔名順序撿每個 *.sql,並在 D1 自己的 d1_migrations
-- 表追蹤已套用者(不看 drizzle 的 journal),故本檔足以支撐 pnpm db:migrate:local。
--
-- 兩個新欄位與四個索引都有在 src/lib/schema.ts 建模,遵循 0009 的做法而非 0007 的
-- 省略索引。唯一維持 raw-SQL-only 的是 content_fts 虛擬表(drizzle 無法建模,見 0005
-- 檔頭),其新增的 locale 欄記在 schema.ts 中 contents 旁的註解。
--
-- ── 語意 ────────────────────────────────────────────────────────────────────
--   locale             BCP-47 tag,一列一個 (entry, locale)。canonical token 為
--                      'en' / 'zh-Hant'(src/lib/i18n/index.ts 的 Locale,大小寫是
--                      zh-Hant)。站台預設值來自 core.content.defaultLocale(預設 'en'),
--                      與 core.locale(那是「管理介面語言」)刻意分開 —— 否則管理員
--                      切換自己的介面語言會改變匿名訪客看到的內容。
--   translation_group  sibling 譯本連結。group 第一列 = 自己的 id,譯本原樣複製。
--                      寫入路徑一律給值(create 以 `?? id` 保底),DEFAULT '' 只是
--                      SQLite 的 ADD COLUMN NOT NULL 必須有常數預設值,app 端不可達。
--
-- ── 索引 ────────────────────────────────────────────────────────────────────
--   contents_type_slug → contents_type_locale_slug:slug 唯一性從 (type) 範圍移到
--   (type, locale) 範圍。雙語站可跨 locale 共用同一個 slug,也可逐 locale 用不同
--   slug(/about vs /關於)—— 兩種慣例皆合法,schema 不偏袒。
--   contents_group_locale 是完整性不變量:每個 (translation_group, locale) 至多一列。
--   contents_type_updated 刻意保留 —— (type, locale, updated_at) 不以 (type,
--   updated_at) 為前綴,而 seo-cache / dashboard aggregate / widget trend 的
--   locale-agnostic 掃描仍需要它。
--
-- ── content_fts 重建 ────────────────────────────────────────────────────────
-- 一次重建同時解兩件事:
--   1. 加 locale UNINDEXED 欄,雙語站搜尋才不會每筆內容回兩個一模一樣的命中。
--   2. CJK 可搜。unicode61 不做中日韓斷詞,整串中文會被 tokenize 成**一個** token,
--      而 buildMatchQuery 只在最後一詞加 `*`,結果是「關於」找得到「關於我們」但
--      「我們」找不到 —— 只有前綴匹配有效。修法**不在 tokenizer**:trigram 需要
--      查詢至少 3 字,而中文最常見的正是兩字詞,換過去反而更糟。改在應用層:
--      src/lib/search.ts 的 segmentCjk() 在**寫入與查詢兩端**把 CJK 字元逐字以空白
--      隔開,每個字成為獨立 token,查詢再組成 phrase("我 們")要求連續出現。
--      Latin 原樣不動,remove_diacritics 2 的重音摺疊照舊。
-- 不需要任何 backfill 敘述:src/lib/search.ts 的 maybeBackfill() 會在 content_fts
-- 為空而 contents 非空時惰性重建 —— 這也順帶把既有內容改用新的分詞重新索引。
--
-- 撰寫當下沒有 production 資料(零個已部署的客戶站),故下面每個 DEFAULT 都只是形式,
-- 不是被默默蓋到歷史資料上的值。

ALTER TABLE contents ADD COLUMN locale text NOT NULL DEFAULT 'en';
ALTER TABLE contents ADD COLUMN translation_group text NOT NULL DEFAULT '';

-- 空表上是 no-op;讓本 migration 對已有資料的 dev DB 也正確(每列成為只有自己的 group)。
UPDATE contents SET translation_group = id WHERE translation_group = '';

DROP INDEX contents_type_slug;

-- 述詞文字與 drizzle 的產出逐位元組一致(見 0001 第 11 行與 meta/0001_snapshot.json),
-- 未來的 schema diff 才會是 no-op。
CREATE UNIQUE INDEX contents_type_locale_slug
  ON contents (type, locale, slug)
  WHERE "contents"."slug" is not null;

CREATE UNIQUE INDEX contents_group_locale
  ON contents (translation_group, locale);

CREATE INDEX contents_type_locale_updated
  ON contents (type, locale, updated_at);

DROP TABLE content_fts;
CREATE VIRTUAL TABLE content_fts USING fts5(
  content_id UNINDEXED,
  type_key UNINDEXED,
  locale UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
