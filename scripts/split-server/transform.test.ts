// scripts/split-server/ 的測試:用一份模仿 esbuild `__commonJS` 包裝的小 bundle。
// 跑在純 Node(vitest.cli.config.ts):要真的 import 拆出來的 server 模組,確認搬出去的模組
// 由 createRequire 載入、接橋給的是同一份實例而且是當下的值。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SplitError } from "./ast.mjs";
import { rewriteWorkerEntry, serverModuleImports } from "./entry.mjs";
import { FINGERPRINT_FILE, currentFingerprint, fingerprintProblem } from "./fingerprint.mjs";
import { loadNodeCompat } from "./preset.mjs";
import { CHUNK_DIR, splitServerHandler } from "./transform.mjs";

const OPTIONS = {
  compatibilityDate: "2026-07-01",
  nativeModules: new Set(["timers", "node:timers", "crypto", "node:crypto"]),
  nodeBuiltins: new Set(["timers", "crypto", "http", "fs"]),
  injectedGlobals: new Set<string>(),
};

const HELPERS = [
  "var __getOwnPropNames = Object.getOwnPropertyNames;",
  "var __commonJS = (cb, mod) => function() {",
  "  try {",
  "    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;",
  "  } catch (e) { throw mod = 0, e; }",
  "};",
].join("\n");

function bundle(...wrappers: string[]): string {
  return [
    'import { setTimeout } from "node:timers";',
    HELPERS,
    'var require_runtime = __commonJS({ "node_modules/next/dist/runtime.js"(exports2) { exports2.shared = { n: 0 }; } });',
    "var counter = 1;",
    "export function bump() { counter = 2; }",
    ...wrappers,
    "export const handler = () => require_page();",
    "",
  ].join("\n");
}

const CHUNK =
  'var require_chunk = __commonJS({ ".next/server/chunks/12.js"(exports2) {' +
  " exports2.id = 12; exports2.timer = () => typeof setTimeout; exports2.read = () => counter; } });";
const PAGE =
  'var require_page = __commonJS({ "../../.next/server/app/(site)/page.js"(exports2, module) {' +
  " var r = require_runtime(); r.shared.n++;" +
  " module.exports = { chunk: require_chunk().id, timer: require_chunk().timer(), read: require_chunk().read, shared: r.shared, runtime: require_runtime };" +
  " } });";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function split(source: string, options = OPTIONS) {
  return splitServerHandler(source, options);
}

function expectSplitError(source: string, message: RegExp, options = OPTIONS): void {
  expect(() => split(source, options)).toThrowError(SplitError);
  expect(() => split(source, options)).toThrowError(message);
}

async function load(source: string): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const result = split(source);
  const dir = mkdtempSync(path.join(os.tmpdir(), "split-test-"));
  tempDirs.push(dir);
  mkdirSync(path.join(dir, CHUNK_DIR));
  writeFileSync(path.join(dir, "server.mjs"), result.server);
  for (const mod of result.modules) writeFileSync(path.join(dir, CHUNK_DIR, mod.file), mod.source);
  return import(pathToFileURL(path.join(dir, "server.mjs")).href);
}

describe("splitServerHandler", () => {
  it("搬出 chunk 與路由檔,其他包裝留在 server 裡", () => {
    const result = split(bundle(CHUNK, PAGE));
    expect(result.modules.map((mod) => [mod.file, mod.kind])).toEqual([
      ["app_site_page.cjs", "route"],
      ["chunks_12.cjs", "chunk"],
    ]);
    expect(result.kept).toBe(1);
    expect(result.bridged).toEqual(["counter", "require_chunk", "require_runtime", "setTimeout"]);
    expect(result.server).toContain('return __splitRequire("./chunks/chunks_12.cjs")(__splitExports, __splitModule, __splitScope);');
    expect(result.server).toContain("exports2.shared = { n: 0 }");
    expect(result.server).not.toContain("exports2.id = 12");
    const chunk = result.modules.find((mod) => mod.kind === "chunk")?.source ?? "";
    expect(chunk).toContain("module.exports = function (exports2, __splitModule, __splitScope)");
    expect(chunk).toContain("typeof __splitScope.setTimeout");
  });

  it("拆出來的 server 真的能跑:延後載入、同一份實例、讀到當下的值", async () => {
    const server = await load(bundle(CHUNK, PAGE));
    const page = server.handler() as { chunk: number; timer: string; read: () => number; shared: { n: number }; runtime: () => { shared: unknown } };
    expect(page.chunk).toBe(12);
    expect(page.timer).toBe("function");
    expect(page.shared.n).toBe(1);
    // 第二次拿到快取的同一份 exports,本體沒有再跑一次。
    expect(server.handler()).toBe(page);
    expect(page.runtime().shared).toBe(page.shared);
    // live binding:最上層的 var 之後被改,搬出去的程式碼讀到新值。
    expect(page.read()).toBe(1);
    server.bump();
    expect(page.read()).toBe(2);
  });

  it("本體丟錯之後,下一次照樣重跑(搬出去的模組載入時不跑本體)", async () => {
    const flaky =
      'var require_page = __commonJS({ ".next/server/app/flaky/page.js"(exports2) {' +
      ' globalThis.__splitTestRuns = (globalThis.__splitTestRuns ?? 0) + 1; if (globalThis.__splitTestRuns === 1) throw new Error("transient");' +
      " exports2.ok = true; } });";
    const server = await load(bundle(flaky));
    expect(() => server.handler()).toThrowError("transient");
    expect(server.handler()).toEqual({ ok: true });
  });

  it("呼叫、簡寫屬性都保留原本的意思", () => {
    const page = 'var require_page = __commonJS({ ".next/server/app/x/page.js"(exports2) { exports2.o = { require_runtime }; exports2.v = require_runtime(); } });';
    const [mod] = split(bundle(page)).modules;
    expect(mod.source).toContain("{ require_runtime: __splitScope.require_runtime }");
    expect(mod.source).toContain("(0, __splitScope.require_runtime)()");
  });

  it("export 的與最上層區塊裡的 var 也算 bundle 的名字", async () => {
    const extra = "export var exportedValue = 5;\ntry { var tryValue = 6; } catch {}\n";
    const page = 'var require_page = __commonJS({ ".next/server/app/x/page.js"(exports2) { exports2.sum = exportedValue + tryValue; } });';
    const server = await load(extra + bundle(page));
    expect(server.handler()).toEqual({ sum: 11 });
  });

  it("自由範圍的 __dirname 改讀 globalThis", () => {
    const chunk = 'var require_chunk = __commonJS({ ".next/server/chunks/7.js"(exports2) { exports2.dir = __dirname; } });';
    const [mod] = split(bundle(chunk)).modules;
    expect(mod.source).toContain("exports2.dir = globalThis.__dirname;");
  });

  it("區塊裡的 let module 只在區塊內有效", () => {
    const ok = 'var require_x = __commonJS({ ".next/server/chunks/8.js"(exports2) { { let module = {}; module.a = 1; } } });';
    expect(() => split(bundle(ok))).not.toThrow();
    const leak = 'var require_x = __commonJS({ ".next/server/chunks/8.js"(exports2) { { let module; } module.exports = 1; } });';
    expectSplitError(bundle(leak), /自由範圍用到 `module`/);
  });

  it("try 裡 require 選用套件可以;Node 內建模組要是原生的", () => {
    const chunk =
      'var require_x = __commonJS({ ".next/server/chunks/5.js"(exports2) {' +
      ' exports2.c = require("node:crypto"); try { exports2.e = require("@emotion/is-prop-valid"); } catch {} } });';
    const result = split(bundle(chunk));
    expect(result.requires).toEqual(["@emotion/is-prop-valid", "node:crypto"]);
    expect(result.optionalRequires).toEqual(["@emotion/is-prop-valid"]);
  });

  it("require 了這個相容日期不原生提供的 Node 模組就失敗,訊息寫出模組與日期", () => {
    const chunk = 'var require_x = __commonJS({ ".next/server/chunks/5.js"(exports2) { exports2.h = require("node:http"); } });';
    expectSplitError(bundle(chunk), /node:http(.|\n)*2026-07-01/);
  });

  it("require 相對路徑、或 try 外的套件就失敗", () => {
    const relative = 'var require_x = __commonJS({ ".next/server/chunks/5.js"(exports2) { try { require("./other.js"); } catch {} } });';
    expectSplitError(bundle(relative), /\.\/other\.js\(相對路徑\)/);
    const pkg = 'var require_x = __commonJS({ ".next/server/chunks/5.js"(exports2) { require("left-pad"); } });';
    expectSplitError(bundle(pkg), /left-pad\(不是 Node 內建模組,也不是在會接住錯誤的 try 裡 require\)/);
  });

  it("try 只有 finally、或 catch 直接 throw,都不算接住錯誤", () => {
    const finallyOnly = 'var require_x = __commonJS({ ".next/server/chunks/5.js"(exports2) { try { require("left-pad"); } finally {} } });';
    expectSplitError(bundle(finallyOnly), /left-pad/);
    const rethrow = 'var require_x = __commonJS({ ".next/server/chunks/5.js"(exports2) { try { require("left-pad"); } catch (e) { throw e; } } });';
    expectSplitError(bundle(rethrow), /left-pad/);
  });

  it("用到 import.meta 就失敗", () => {
    const chunk = 'var require_x = __commonJS({ ".next/server/chunks/5.js"(exports2) { exports2.u = import.meta.url; } });';
    expectSplitError(bundle(chunk), /import\.meta/);
  });

  it("字面值的 import() 照 require 的規則檢查,不是字面值的維持原樣", () => {
    const relative = 'var require_x = __commonJS({ ".next/server/chunks/5.js"(exports2) { exports2.p = () => import("./x.js"); } });';
    expectSplitError(bundle(relative), /\.\/x\.js\(相對路徑\)/);
    const pkg = 'var require_x = __commonJS({ ".next/server/chunks/5.js"(exports2) { try { exports2.p = import("left-pad"); } catch {} } });';
    expectSplitError(bundle(pkg), /left-pad/);
    const ok = 'var require_x = __commonJS({ ".next/server/chunks/5.js"(exports2) { exports2.a = () => import("node:crypto"); exports2.b = (n) => import(n); } });';
    expect(split(bundle(ok)).requires).toEqual(["node:crypto"]);
  });

  it("參數的預設值看不到本體的 var:最上層名字照樣接橋", async () => {
    const page =
      'var require_page = __commonJS({ ".next/server/app/x/page.js"(exports2) {' +
      " function f(a = counter) { var counter = 9; return a; } exports2.v = f(); } });";
    const result = split(bundle(page));
    expect(result.bridged).toContain("counter");
    expect(result.modules[0].source).toContain("a = __splitScope.counter");
    const server = await load(bundle(page));
    expect(server.handler()).toEqual({ v: 1 });
  });

  it("class 的 static 區塊裡的 var 只屬於那個區塊", () => {
    const page =
      'var require_page = __commonJS({ ".next/server/app/x/page.js"(exports2) {' +
      " class A { static { var counter = 3; } } exports2.v = counter; } });";
    const result = split(bundle(page));
    expect(result.bridged).toContain("counter");
    expect(result.modules[0].source).toContain("exports2.v = __splitScope.counter");
  });

  it("不是字面值的 require 就失敗", () => {
    const chunk = 'var require_x = __commonJS({ ".next/server/chunks/5.js"(exports2) { exports2.f = (n) => require(n); } });';
    expectSplitError(bundle(chunk), /用 require 的方式/);
  });

  it("用到打包時會注入的全域就失敗", () => {
    const chunk = 'var require_x = __commonJS({ ".next/server/chunks/5.js"(exports2) { exports2.p = process.env; } });';
    expectSplitError(bundle(chunk), /`process`/, { ...OPTIONS, injectedGlobals: new Set(["process"]) });
  });

  it("寫入 bundle 最上層的名字就失敗", () => {
    const chunk = 'var require_x = __commonJS({ ".next/server/chunks/5.js"(exports2) { counter = 3; } });';
    expectSplitError(bundle(chunk), /寫入 bundle 最上層的 `counter`/);
  });

  it("用到包裝函式自己的 arguments 就失敗", () => {
    const chunk = 'var require_x = __commonJS({ ".next/server/chunks/5.js"(exports2) { exports2.n = arguments.length; } });';
    expectSplitError(bundle(chunk), /arguments/);
  });

  it("沒有 __commonJS 輔助函式就失敗", () => {
    expectSplitError("export const handler = () => 1;\n", /__commonJS/);
  });

  it("找不到任何 chunk 或路由檔就失敗", () => {
    expectSplitError(bundle(), /找不到任何/);
  });

  it("認不得的包裝形狀就失敗", () => {
    const odd = 'var require_odd = __commonJS({ "a.js"() {}, "b.js"() {} });';
    expectSplitError(bundle(odd, CHUNK), /認不得的 __commonJS 包裝/);
  });

  it("chunk 包裝不在最上層的 var 就失敗", () => {
    const nested = 'function f() { return __commonJS({ ".next/server/chunks/3.js"(exports2) {} }); }';
    expectSplitError(bundle(nested, CHUNK), /不在最上層/);
  });

  it("自由範圍的 module 就失敗", () => {
    const free = 'var require_x = __commonJS({ ".next/server/chunks/9.js"(exports2) { module.exports = 1; } });';
    expectSplitError(bundle(free), /自由範圍用到 `module`/);
  });

  it("兩個路徑寫成同一個檔名就失敗,只差大小寫也算", () => {
    const a = 'var require_a = __commonJS({ ".next/server/app/(site)/page.js"(exports2) {} });';
    const b = 'var require_b = __commonJS({ ".next/server/app/site/page.js"(exports2) {} });';
    expectSplitError(bundle(a, b), /同一個檔名/);
    const upper = 'var require_c = __commonJS({ ".next/server/app/About/page.js"(exports2) {} });';
    const lower = 'var require_d = __commonJS({ ".next/server/app/about/page.js"(exports2) {} });';
    expectSplitError(bundle(upper, lower), /不分大小寫/);
  });

  it("server 用相對路徑 import 就失敗", () => {
    expectSplitError(`import x from "./x.js";\n${bundle(CHUNK)}`, /相對路徑/);
  });

  it("解析不了就失敗", () => {
    expectSplitError("var = ;", /無法解析/);
  });
});

describe("rewriteWorkerEntry", () => {
  const worker = [
    'import { init } from "./cloudflare/init.js";',
    'export { DOQueueHandler } from "./.build/durable-objects/queue.js";',
    "export default { async fetch() {",
    '  const { handler } = await import("./server-functions/default/handler.mjs");',
    "  return handler(init);",
    "} };",
  ].join("\n");
  const options = {
    importPrefix: "..",
    serverImport: "./server-functions/default/handler.mjs",
    serverTarget: "./server/handler.js",
  };

  it("相對 import 改指回原資料夾,載入 server 的那一行改成非字面值", () => {
    const out = rewriteWorkerEntry(worker, options);
    expect(out).toContain('from "../cloudflare/init.js"');
    expect(out).toContain('from "../.build/durable-objects/queue.js"');
    expect(out).toContain('await import(["./server","handler.js"].join("/"))');
    expect(out).not.toContain("server-functions");
  });

  it("找不到載入 server 的那一行就失敗", () => {
    const without = worker.replace('await import("./server-functions/default/handler.mjs")', "{ handler: () => null }");
    expect(() => rewriteWorkerEntry(without, options)).toThrowError(/實際找到 0 個/);
  });

  it("載入 server 的地方不只一處就失敗", () => {
    const twice = worker.replace("return handler(init);", 'await import("./server-functions/default/handler.mjs"); return handler(init);');
    expect(() => rewriteWorkerEntry(twice, options)).toThrowError(/實際找到 2 個/);
  });

  it("還有別的相對路徑動態 import 就失敗", () => {
    const other = worker.replace("return handler(init);", 'await import("./other.js"); return handler(init);');
    expect(() => rewriteWorkerEntry(other, options)).toThrowError(/另一個相對路徑的動態 import/);
  });
});

describe("serverModuleImports", () => {
  it("列出相對路徑的 wasm,不管 node: 與裸名稱", () => {
    const source = 'import a from "./b-yoga.wasm";\nimport c from "./a-resvg.wasm";\nimport { x } from "node:fs";\nexport { a, c, x };\n';
    expect(serverModuleImports(source, [".wasm"])).toEqual(["a-resvg.wasm", "b-yoga.wasm"]);
  });

  it("預期之外的相對 import 就失敗", () => {
    expect(() => serverModuleImports('import a from "./data.bin";\nexport { a };\n', [".wasm"])).toThrowError(/預期之外/);
  });
});

describe("loadNodeCompat", () => {
  const root = path.resolve(import.meta.dirname, "..", "..");

  it("從安裝的 wrangler 讀出原生模組與注入的全域,隨相容日期變", async () => {
    const recent = await loadNodeCompat(root, { compatibility_date: "2026-07-01", compatibility_flags: ["nodejs_compat"] });
    expect(recent.nativeModules.has("node:async_hooks")).toBe(true);
    expect(recent.nativeModules.has("node:http")).toBe(true);
    expect(recent.nodeBuiltins.has("http")).toBe(true);
    const old = await loadNodeCompat(root, { compatibility_date: "2024-09-23", compatibility_flags: ["nodejs_compat"] });
    expect(old.nativeModules.has("node:http")).toBe(false);
    expect(old.injectedGlobals.has("process")).toBe(true);
  });
});

describe("fingerprintProblem", () => {
  function fakeBuild(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "split-fp-"));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, "server-functions", "default"), { recursive: true });
    writeFileSync(path.join(dir, "server-functions", "default", "handler.mjs"), "export const a = 1;\n");
    writeFileSync(path.join(dir, "worker.js"), "export default {};\n");
    return dir;
  }

  it("沒有拆分輸出就說明", () => {
    expect(fingerprintProblem(fakeBuild())).toMatch(/沒有拆分輸出/);
  });

  it("指紋對得上就通過,重新 build 之後沒有重新拆分就失敗", () => {
    const dir = fakeBuild();
    mkdirSync(path.join(dir, "split"));
    writeFileSync(path.join(dir, "split", FINGERPRINT_FILE), JSON.stringify(currentFingerprint(dir)));
    expect(fingerprintProblem(dir)).toBeNull();
    writeFileSync(path.join(dir, "server-functions", "default", "handler.mjs"), "export const a = 2;\n");
    expect(fingerprintProblem(dir)).toMatch(/上一次 build/);
  });
});
