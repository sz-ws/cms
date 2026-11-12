// 拆分的另外兩個純轉換:OpenNext 的 worker.js 改寫成拆分入口用的版本,以及檢查 wrangler 打包好的
// server 模組 import 了哪些相對路徑的檔案。說明見 transform.mjs 與 worker/README.md。
import { SplitError, parse, walk } from "./ast.mjs";

/**
 * OpenNext 的 worker.js 改寫成放在另一個資料夾的版本:相對 import 加上 `importPrefix`,
 * 載入 server 的那一行改成非字面值的路徑(否則 esbuild 會把 server 併回主模組)。
 *
 * @param {string} source `.open-next/worker.js` 的內容
 * @param {{ importPrefix: string, serverImport: string, serverTarget: string }} options
 *   importPrefix:新位置回到原位置的相對路徑(例如 "..");serverImport:原本載入 server 的字面值;
 *   serverTarget:執行時要載入的模組(相對於打包後的主模組)。
 */
export function rewriteWorkerEntry(source, { importPrefix, serverImport, serverTarget }) {
  const program = parse(source, "worker.js");
  const edits = [];
  const relocate = (node) => {
    const value = node.value;
    if (typeof value !== "string" || !/^\.\.?\//.test(value)) return;
    const joined = `${importPrefix}/${value.replace(/^\.\//, "")}`;
    edits.push({ start: node.start, end: node.end, text: JSON.stringify(joined) });
  };
  for (const stmt of program.body) {
    if (
      (stmt.type === "ImportDeclaration" || stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportAllDeclaration") &&
      stmt.source
    ) {
      relocate(stmt.source);
    }
  }

  const serverImports = [];
  walk(program, (node) => {
    if (node.type !== "ImportExpression") return true;
    if (node.source.type === "Literal" && node.source.value === serverImport) {
      serverImports.push(node.source);
    } else if (node.source.type === "Literal" && /^\.\.?\//.test(String(node.source.value))) {
      throw new SplitError(`worker.js 有另一個相對路徑的動態 import:${node.source.value}`);
    }
    return true;
  });
  if (serverImports.length !== 1) {
    throw new SplitError(
      `worker.js 裡預期正好一個 \`import(${JSON.stringify(serverImport)})\`,實際找到 ${serverImports.length} 個。`,
    );
  }
  const cut = serverTarget.lastIndexOf("/");
  const parts = [serverTarget.slice(0, cut), serverTarget.slice(cut + 1)];
  edits.push({
    start: serverImports[0].start,
    end: serverImports[0].end,
    text: `${JSON.stringify(parts)}.join("/")`,
  });

  let out = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/**
 * wrangler 打包好的 server 模組裡的相對 import(wasm 之類,要跟它放在一起)。
 * 只接受 `allowedExtensions` 裡的副檔名,其他的代表打包結果跟預期不同。
 */
export function serverModuleImports(source, allowedExtensions) {
  const program = parse(source, "打包後的 server 模組");
  const relative = [];
  for (const stmt of program.body) {
    const spec = stmt.source && stmt.source.value;
    if (typeof spec !== "string" || !/^\.\.?\//.test(spec)) continue;
    if (!allowedExtensions.some((ext) => spec.endsWith(ext)) || spec.startsWith("../")) {
      throw new SplitError(`打包後的 server 模組 import 了預期之外的檔案:${spec}`);
    }
    relative.push(spec.replace(/^\.\//, ""));
  }
  return relative.sort();
}
