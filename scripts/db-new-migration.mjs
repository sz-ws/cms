#!/usr/bin/env node
// 手寫 migration 的鷹架:pnpm db:new <slug>
//
// db:generate 的替代品(那條路已停用,見 package.json 的說明):自動挑下一個
// 編號、鋪好記載本 repo migration 紀律的檔頭,讓「手寫 SQL」這件事有一條被
// 引導的路,而不是一句 error message。慣例本身由 test/migration-parity.test.ts
// 機器驗證(從零套用全部 migration 到真 D1,逐表逐欄逐索引與 src/lib/schema.ts
// 比對),這裡的檔頭只是把同一份紀律寫在人會讀到的地方。

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const migrationsDir = path.join(root, "migrations");

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const slug = process.argv[2];
if (!slug) die("用法:pnpm db:new <slug>(如 pnpm db:new content_pinning)");
if (!/^[a-z0-9_]+$/.test(slug))
  die(`slug 只能是小寫 a-z、0-9、底線(拿到:${slug})—— 檔名參與 wrangler 的套用順序,保持可預測`);

const existing = fs
  .readdirSync(migrationsDir)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort();
if (existing.length === 0) die("migrations/ 裡找不到既有的 NNNN_*.sql,不敢猜編號");

const next = Math.max(...existing.map((f) => Number(f.slice(0, 4)))) + 1;
const name = `${String(next).padStart(4, "0")}_${slug}.sql`;
const file = path.join(migrationsDir, name);
if (fs.existsSync(file)) die(`${name} 已存在`);

const header = `-- <一行說明:這個 migration 改了什麼>
--
-- Hand-written (NOT drizzle-kit generated),沿用 0006..${existing[existing.length - 1].slice(0, 4)} 的體例。drizzle 的
-- journal (migrations/meta/_journal.json) 凍結在 0004,0005 起全部是 out-of-journal
-- 手寫檔,且 \`pnpm db:generate\` 已停用。\`wrangler d1 migrations apply\` 依檔名順序
-- 撿每一個 *.sql,並在 D1 自己的 d1_migrations 表記錄已套用者,所以本檔即足夠。
-- migration 是 append-only 的:本檔不改任何既有檔案一個字。
--
-- 紀律(test/migration-parity.test.ts 機器驗證,紅燈擋在 merge 前):
--   * 寫完 SQL 後跑 \`pnpm db:checksums\` 把本檔登錄進 append-only 帳本
--     (migrations/meta/_checksums.json);登錄後這個檔就不該再被改一個字。
--   * 表/欄位/索引**同時**宣告於 src/lib/schema.ts(同名同欄),遵守 0014 立下的
--     規則 —— schema.ts 是資料庫的完整描述,不是產生器的輸入。
--   * drizzle 建模不了的構造(FTS5 虛擬表等)是唯一例外:加進該測試的
--     RAW_SQL_ONLY_TABLES 清單,並在 schema.ts 相鄰處留註解,別讓它失聯。
--   * 無 trigger、字串常值內無 \`;\` 或 \`--\`(該測試的 SQL 切分器假設如此;
--     真需要時先擴充切分器)。
--   * 設計取捨寫在這個檔頭 —— 讓下一個讀 SQL 的人拿得到「為什麼」。
--
-- 完成後:pnpm db:checksums && pnpm test:run test/migration-parity.test.ts && pnpm db:migrate:local

`;

fs.writeFileSync(file, header);
console.log(`✓ 建立 migrations/${name}`);
console.log("  1. 在檔尾寫 SQL(檔頭的 <一行說明> 記得換掉)");
console.log("  2. 同步宣告 src/lib/schema.ts(同名同欄)");
console.log("  3. pnpm db:checksums(登錄進 append-only 帳本)");
console.log("  4. pnpm test:run test/migration-parity.test.ts");
console.log("  5. pnpm db:migrate:local");
