#!/usr/bin/env node
// 輕量 extension 落地:pnpm ext:add <tgz 或資料夾> [--force]
//
// ext-pack 的另一半:把打包好的 extension 解到本 project 的 extensions/<id>/,
// 對 pack.json 的 coreApi 做 caret 相容檢查,最後印出 registry.ts 要加的兩行
// (不自動改 registry.ts —— 那是唯一需要人工維護的檔案,保持它可讀可審)。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2).filter((a) => a !== "--force");
const force = process.argv.includes("--force");
const input = args[0];

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!input) die("用法:pnpm ext:add <tgz 或資料夾> [--force]");
const inputPath = path.resolve(process.cwd(), input);
if (!fs.existsSync(inputPath)) die(`${input} 不存在`);

// ---- 取得來源資料夾(tgz 先解到暫存)----
let srcDir = inputPath;
let tmpDir = null;
if (fs.statSync(inputPath).isFile()) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suko-ext-add-"));
  execFileSync("tar", ["-xzf", inputPath, "-C", tmpDir]);
  const entries = fs
    .readdirSync(tmpDir)
    .filter((e) => fs.statSync(path.join(tmpDir, e)).isDirectory());
  if (entries.length !== 1) die("tgz 內應恰好包含一個 extension 資料夾");
  srcDir = path.join(tmpDir, entries[0]);
}
if (!fs.existsSync(path.join(srcDir, "index.ts"))) {
  die("來源缺 index.ts —— 不是 extension 資料夾");
}
const id = path.basename(srcDir);
if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) die(`資料夾名 "${id}" 不是合法 extension id`);

// ---- coreApi caret 相容檢查(pack.json 有才驗;沒有就只提示)----
const packPath = path.join(srcDir, "pack.json");
const pack = fs.existsSync(packPath)
  ? JSON.parse(fs.readFileSync(packPath, "utf8"))
  : null;
const versionSrc = fs.readFileSync(
  path.join(root, "src/ext/version.ts"),
  "utf8",
);
const coreVersion = versionSrc.match(
  /CORE_API_VERSION = "(\d+)\.(\d+)\.(\d+)"/,
);
if (pack?.coreApi && coreVersion) {
  const m = pack.coreApi.match(/^\^?(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [, reqMajor, reqMinor] = m.map(Number);
    const [, curMajor, curMinor] = coreVersion.map(Number);
    const compatible =
      reqMajor === curMajor &&
      (curMinor > reqMinor || curMinor === reqMinor);
    if (!compatible) {
      die(
        `coreApi ${pack.coreApi} 與本 project 的 CORE_API_VERSION ${coreVersion.slice(1).join(".")} 不相容`,
      );
    }
  }
}

// ---- 落地 ----
const destDir = path.join(root, "extensions", id);
if (fs.existsSync(destDir) && !force) {
  die(`extensions/${id}/ 已存在(要覆蓋加 --force)`);
}
fs.rmSync(destDir, { recursive: true, force: true });
fs.cpSync(srcDir, destDir, { recursive: true });
if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });

// ---- 指路 ----
const camel = id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
console.log(`✓ extensions/${id}/ 已落地${pack ? `(version ${pack.version} · coreApi ${pack.coreApi})` : ""}`);
if (pack?.deps?.length) {
  console.log(`  package 依賴(package.json 缺的要補):${pack.deps.join(", ")}`);
}
console.log(`\n接著手動把它接進 extensions/registry.ts(唯一需要人工維護的檔案):`);
console.log(`  import { ${camel} } from "./${id}";`);
console.log(`  // registry 陣列加入:${camel}`);
console.log(`\n然後 admin → Extensions → 啟用(kind:"code";enable 時自動跑 migration)。`);
