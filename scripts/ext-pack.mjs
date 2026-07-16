#!/usr/bin/env node
// 輕量 extension 打包:pnpm ext:pack <id>
//
// 把 extensions/<id>/ 打成 dist-ext/<id>-<version>.tgz(附 pack.json 記錄
// id/version/coreApi/依賴),供另一個 Suko CMS project 以 `pnpm ext:add <tgz>`
// 落地。同時做 import 邊界檢查:
//   - 相對路徑 / "@/ext/*"(core 公開 API)→ OK
//   - 其他 "@/*"(@/lib、@/components…,host 內部)→ 警告(目標 project 需有
//     同版 core 才保證存在)
//   - bare package(zod、react…)→ 列出,目標 project 的 package.json 需自備
//
// 刻意保持簡單(su-ext-cli-ideas.md:「保持簡單,不要過度設計」)—— 這不是
// registry 發布工具,只回答「搬去另一個 project」。

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const id = process.argv[2];

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!id || !/^[a-z][a-z0-9-]{1,30}$/.test(id)) {
  die("用法:pnpm ext:pack <extension-id>");
}
const srcDir = path.join(root, "extensions", id);
if (!fs.existsSync(path.join(srcDir, "index.ts"))) {
  die(`extensions/${id}/index.ts 不存在`);
}

// ---- 從 index.ts 撈 version / coreApi(regex 夠用,别為此拉編譯器)----
const indexSrc = fs.readFileSync(path.join(srcDir, "index.ts"), "utf8");
const version = indexSrc.match(/version:\s*"(\d+\.\d+\.\d+)"/)?.[1] ?? "0.0.0";
const coreApi =
  indexSrc.match(/coreApi:\s*"([^"]+)"/)?.[1] ?? "(未宣告)";

// ---- import 邊界掃描 ----
const files = fs
  .readdirSync(srcDir, { recursive: true })
  .filter((f) => /\.(ts|tsx)$/.test(f));
const coreImports = new Set();
const hostLeaks = new Set(); // "@/lib/*" 等 —— 依賴 host 內部,可能綁 core 版本
const deps = new Set();
for (const file of files) {
  const src = fs.readFileSync(path.join(srcDir, file), "utf8");
  for (const m of src.matchAll(/(?:from\s+|import\()\s*["']([^"']+)["']/g)) {
    const spec = m[1];
    if (spec.startsWith(".")) continue;
    if (spec.startsWith("@/ext/")) coreImports.add(spec);
    else if (spec.startsWith("@/")) hostLeaks.add(`${spec}(${file})`);
    else if (spec !== "react" && spec !== "node:process") {
      deps.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
    }
  }
}

// ---- staging + tar ----
const distDir = path.join(root, "dist-ext");
const stageDir = path.join(distDir, ".stage", id);
fs.rmSync(path.join(distDir, ".stage"), { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });
fs.cpSync(srcDir, stageDir, { recursive: true });
fs.writeFileSync(
  path.join(stageDir, "pack.json"),
  JSON.stringify(
    {
      id,
      version,
      coreApi,
      deps: [...deps].sort(),
      coreImports: [...coreImports].sort(),
      packedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
const tgz = path.join(distDir, `${id}-${version}.tgz`);
execFileSync("tar", ["-czf", tgz, "-C", path.join(distDir, ".stage"), id]);
fs.rmSync(path.join(distDir, ".stage"), { recursive: true, force: true });

// ---- 報告 ----
console.log(`✓ ${path.relative(root, tgz)}`);
console.log(`  id ${id} · version ${version} · coreApi ${coreApi}`);
if (coreImports.size) {
  console.log(`  core API imports(目標 project 需相容 core):`);
  for (const s of [...coreImports].sort()) console.log(`    - ${s}`);
}
if (deps.size) {
  console.log(`  package 依賴(目標 project 的 package.json 需自備):`);
  for (const s of [...deps].sort()) console.log(`    - ${s}`);
}
if (hostLeaks.size) {
  console.log(`  ⚠ host 內部 import(非 @/ext 公開 API,可攜性風險):`);
  for (const s of [...hostLeaks].sort()) console.log(`    - ${s}`);
}
