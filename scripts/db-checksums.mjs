#!/usr/bin/env node
// migration 的 append-only 帳本:pnpm db:checksums [--check]
//
// 為什麼需要:migrations/ 是 append-only 的 —— 每個既有部署的 D1 都已經套用過舊
// 檔(D1 自己的 d1_migrations 記著誰套過),事後改一個舊檔不會回頭改任何資料庫,
// 只會讓「從零套用」與「既有站」分岔成兩個不同的 schema,而且兩邊都不報錯。
//
// test/migration-parity.test.ts 驗的是前者(從零套用 == src/lib/schema.ts),它
// 天生看不到這種分岔:改過的舊檔跟著改過的 schema.ts,從零套用照樣自洽全綠。
// 這個帳本補的就是那一格 —— 舊檔的 sha256 一旦變動就紅,把「改了已出貨的
// migration」從一個安靜的動作變成 review 裡看得見的一行 diff。
//
// 換行正規化成 LF 再雜湊:repo 沒有 .gitattributes,Windows 上 core.autocrlf 的
// checkout 會拿到 CRLF —— 那不該讓帳本永遠紅。
//
// 用法:寫完新 migration 的 SQL 後跑 `pnpm db:checksums` 登錄。
// `--check` 只比對不寫入(給 pre-commit hook 用;CI 走的是那支測試)。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const migrationsDir = path.join(root, "migrations");
const ledgerPath = path.join(migrationsDir, "meta", "_checksums.json");
const checkOnly = process.argv.includes("--check");

const NOTE =
  "migrations/ 的 append-only 帳本:每個已提交的 NNNN_*.sql 的 sha256(內容先把 CRLF 正規化成 LF)。" +
  "舊檔在既有部署的 D1 上早就套用過了,改檔案不會回頭改資料庫 —— 所以舊檔的雜湊變動就是要在 review 擋下的東西。" +
  "新增 migration 後跑 `pnpm db:checksums` 登錄;test/migration-parity.test.ts 會驗這份帳本。";

const sha256 = (file) =>
  crypto
    .createHash("sha256")
    .update(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");

const names = fs
  .readdirSync(migrationsDir)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort();
if (names.length === 0) {
  console.error("✗ migrations/ 裡找不到任何 NNNN_*.sql,不寫空帳本");
  process.exit(1);
}

const files = Object.fromEntries(names.map((n) => [n, sha256(path.join(migrationsDir, n))]));
const next = { note: NOTE, algorithm: "sha256", normalization: "CRLF→LF", files };

const previous = fs.existsSync(ledgerPath)
  ? JSON.parse(fs.readFileSync(ledgerPath, "utf8"))
  : null;
const previousFiles = previous?.files ?? {};

const changed = names.filter((n) => n in previousFiles && previousFiles[n] !== files[n]);
const added = names.filter((n) => !(n in previousFiles));
const removed = Object.keys(previousFiles).filter((n) => !(n in files));

if (checkOnly) {
  if (changed.length === 0 && added.length === 0 && removed.length === 0) {
    console.log(`✓ ${names.length} 個 migration 與帳本相符`);
    process.exit(0);
  }
  for (const n of changed) console.error(`✗ ${n} 內容變了 —— 已出貨的 migration 是 append-only,不該改`);
  for (const n of added) console.error(`✗ ${n} 尚未登錄 —— 跑 pnpm db:checksums`);
  for (const n of removed) console.error(`✗ ${n} 從 migrations/ 消失 —— 已出貨的 migration 不該刪`);
  process.exit(1);
}

fs.writeFileSync(ledgerPath, `${JSON.stringify(next, null, 2)}\n`);
if (!previous) console.log(`✓ 建立 migrations/meta/_checksums.json(${names.length} 個 migration)`);
else if (changed.length === 0 && added.length === 0 && removed.length === 0)
  console.log(`✓ 帳本已是最新(${names.length} 個 migration)`);
else {
  console.log(`✓ 更新 migrations/meta/_checksums.json`);
  for (const n of added) console.log(`  + ${n}`);
  // 舊檔的雜湊變動照樣寫進去(這支腳本不是守門員,守門的是測試與 review),
  // 但這裡要吵一聲 —— 不然它就是一個讓人安靜蓋掉證據的工具。
  for (const n of changed) console.log(`  ⚠ ${n} 內容變了 —— 已出貨的 migration 應為 append-only,確認這是刻意的`);
  for (const n of removed) console.log(`  ⚠ ${n} 已消失 —— 已出貨的 migration 不該刪`);
}
