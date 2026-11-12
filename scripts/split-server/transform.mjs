// 拆分 Next server 的純轉換:輸入原始碼字串,輸出新的原始碼字串,不碰檔案系統。
// CLI(scripts/split-server-chunks.mjs)負責讀寫檔案與呼叫 wrangler;測試直接呼叫這裡。
//
// ## 在做什麼
//
// OpenNext 用一次 esbuild 把 Next server 打包成 handler.mjs。webpack 的每個 chunk
// (.next/server/chunks/*.js)與每個路由檔(.next/server/app/**/*.js)在裡面都被包成
//
//   var require_X = __commonJS({ ".next/server/chunks/123.js"(exports2, module2) { …本體… } });
//
// splitServerHandler 把本體搬到一個 CommonJS 模組,模組只匯出一個函式(本體包在裡面),原處的本體
// 換成「載入那個模組,呼叫它」:
//
//   var require_X = __commonJS({ ".next/server/chunks/123.js"(__splitExports, __splitModule) {
//     return __splitRequire("./chunks/chunks_123.cjs")(__splitExports, __splitModule, __splitScope); } });
//
// `__splitRequire` 是綁在 server 模組自己網址上的 createRequire。開了 `new_module_registry` 的 Worker
// 只在第一次 require 時才編譯那個模組,所以每個請求只編譯它用到的 chunk。
//
// 搬出去的模組只定義函式,載入時不跑本體,所以本體丟出的錯誤不會被 workerd 的模組快取記住:
// workerd 對求值時丟錯的 CommonJS 模組,之後每次 require 都丟同一個錯、不再重跑(2026-11-12 在本機
// workerd 實測)。本體照舊由 esbuild 的 `__commonJS` 呼叫,丟錯之後下次重跑,快取與重試都跟原本一樣。
//
// ## 接橋
//
// 本體會用到 bundle 最上層的名字(`require_webpack_runtime`、各個 async storage 的 `require_*`、
// esbuild 的 `__toESM`、OpenNext 在檔頭 import 的 setTimeout 等)。它們必須跟 Next runtime 是同一份
// 實例,所以 server 模組在檔頭建一個 getter 物件 `__splitScope`,每次呼叫時傳給搬出去的函式;本體裡
// 每一處引用 `x` 都改寫成 `__splitScope.x`,每次讀都經過 getter,拿到的是當下的值(live binding,
// 跟原本一樣;還沒初始化的 let / const 照樣丟 TDZ 錯誤)。寫入這些名字的程式碼直接失敗。
//
// ## 為什麼要嚴格失敗
//
// 這段處理綁在 OpenNext 與 esbuild 的輸出形狀上。任何一處不符預期都直接丟 SplitError,不做部分
// 拆分:拆了一半的 Worker 能打包、能部署,卻要到某個請求才壞。
import { FUNCTION_TYPES, SplitError, bindingNames, parse, walk } from "./ast.mjs";
import { forEachFreeReference } from "./scope.mjs";

export { SplitError };

/** 搬出去的模組放在 server 模組旁邊的這個資料夾。 */
export const CHUNK_DIR = "chunks";

const REQUIRE_NAME = "__splitRequire";
const CREATE_REQUIRE_NAME = "__splitCreateRequire";
const SCOPE_NAME = "__splitScope";
const EXPORTS_PARAM = "__splitExports";
const MODULE_PARAM = "__splitModule";
const RESERVED = [REQUIRE_NAME, CREATE_REQUIRE_NAME, SCOPE_NAME, EXPORTS_PARAM, MODULE_PARAM];

// `.next/server/chunks/…` 與 `.next/server/app/…`:這兩類搬出去。其餘的(webpack-runtime.js、
// instrumentation.js、node_modules 裡的套件)留在 server 模組裡。
const SPLIT_KEY = /(?:^|\/)\.next\/server\/((?:chunks|app)\/.+)$/;

// CommonJS 模組自己就有的名字。本體在自由範圍用到時:
// - module / exports:會改到搬出去那個模組自己的匯出,直接失敗。
// - __filename / __dirname:原本是查全域(OpenNext 在 globalThis 上設 __dirname),改寫成
//   `globalThis.__dirname`。唯一的差別是全域沒有這個名字時,原本丟 ReferenceError,現在拿到
//   undefined(實測只出現在 Sentry 不會在 Workers 上走到的分支)。
// - require:原本也是查全域,搬出去之後是 workerd 的 CommonJS require,不經過 wrangler 打包時的
//   unenv 別名。所以只接受字面值的模組名稱:Node 內建模組必須是這個相容日期下 workerd 原生提供的
//   (呼叫端給 nativeModules);套件名稱只在會接住錯誤的 try 裡允許(有 catch、catch 最上層沒有
//   throw;選用的相依,例如 framer-motion 試著載入 @emotion/is-prop-valid,失敗就略過:原本與搬出去
//   之後都是丟錯、被 catch 接住);相對路徑與其他用法直接失敗。字面值的 import("…") 同一套規則,
//   但沒有 try 的例外。
const FAIL_NAMES = new Set(["module", "exports"]);
const GLOBAL_LOOKUP_NAMES = new Set(["__filename", "__dirname"]);

/** 最上層的名字:直接宣告的、export 的、import 的,以及最上層區塊 / try 裡的 var。 */
function topLevelNames(program) {
  const names = new Set();
  const addDeclaration = (decl) => {
    if (!decl) return;
    if (decl.type === "VariableDeclaration") {
      for (const d of decl.declarations) for (const name of bindingNames(d.id)) names.add(name);
    } else if ((decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") && decl.id) {
      names.add(decl.id.name);
    }
  };
  for (const stmt of program.body) {
    if (stmt.type === "ImportDeclaration") for (const spec of stmt.specifiers) names.add(spec.local.name);
    else if (stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportDefaultDeclaration") addDeclaration(stmt.declaration);
    else addDeclaration(stmt);
  }
  // var 穿過區塊屬於模組範圍(不進函式與 class)。
  walk(program, (node) => {
    if (FUNCTION_TYPES.has(node.type) || node.type === "ClassBody") return false;
    if (node.type === "VariableDeclaration" && node.kind === "var") addDeclaration(node);
    return true;
  });
  return names;
}

/** 路徑 → 模組檔名。不同路徑撞成同一個檔名(包括只差大小寫)時由呼叫端擋下。 */
function moduleFileName(rel) {
  return `${rel.replace(/\.js$/, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}.cjs`;
}

/** 找出所有 `__commonJS({ "<key>"(…) { … } })` 並分類;形狀不認得就失敗。 */
function findWrappers(program, source) {
  const topInits = new Map();
  for (const stmt of program.body) {
    if (stmt.type !== "VariableDeclaration") continue;
    for (const decl of stmt.declarations) if (decl.init) topInits.set(decl.init, { stmt, decl });
  }

  const wrappers = [];
  walk(program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || node.callee.name !== "__commonJS") {
      return true;
    }
    const arg = node.arguments[0];
    const prop = arg && arg.type === "ObjectExpression" && arg.properties.length === 1 ? arg.properties[0] : null;
    const fn = prop && prop.type === "Property" ? prop.value : null;
    const where = source.slice(node.start, Math.min(node.end, node.start + 120));
    if (
      node.arguments.length !== 1 ||
      !prop ||
      prop.computed ||
      prop.key.type !== "Literal" ||
      typeof prop.key.value !== "string" ||
      !fn ||
      fn.type !== "FunctionExpression" ||
      fn.async ||
      fn.generator ||
      fn.params.length > 2 ||
      fn.params.some((param) => param.type !== "Identifier")
    ) {
      throw new SplitError(
        "認不得的 __commonJS 包裝。預期 `__commonJS({ \"<路徑>\"(exports, module) { … } })`," +
          `實際是:${where}…`,
      );
    }
    const key = prop.key.value;
    const match = key.match(SPLIT_KEY);
    if (!match) {
      wrappers.push({ split: false, key });
      return true;
    }
    const rel = match[1];
    if (!rel.endsWith(".js")) {
      throw new SplitError(`chunk 或路由檔的包裝不是 .js:${key}`);
    }
    const top = topInits.get(node);
    if (!top || top.decl.id.type !== "Identifier" || top.stmt.kind !== "var") {
      throw new SplitError(`chunk 或路由檔的包裝不在最上層的 \`var require_X = __commonJS(…)\`:${key}`);
    }
    wrappers.push({ split: true, key, rel, fn });
    return false;
  });
  return wrappers;
}

/** 這個引用是不是在被寫入(指定、++、delete、解構指定、for-in/of 的左邊)。 */
function isWrite({ parent, key, grandparent }) {
  switch (parent?.type) {
    case "AssignmentExpression":
      return key === "left";
    case "UpdateExpression":
      return true;
    case "UnaryExpression":
      return parent.operator === "delete";
    case "ForInStatement":
    case "ForOfStatement":
      return key === "left";
    case "ArrayPattern":
    case "RestElement":
      return true;
    case "AssignmentPattern":
      return key === "left";
    case "Property":
      return key === "value" && grandparent?.type === "ObjectPattern";
    default:
      return false;
  }
}

/** 把一個識別字引用改寫成 `expression`,保留原本的意思(呼叫時 this 不變、簡寫屬性保留屬性名)。 */
function rewriteEdit(ref, expression) {
  const { node, parent, key } = ref;
  let text = expression;
  if (parent?.type === "Property" && parent.shorthand && key === "value") text = `${node.name}: ${expression}`;
  else if ((parent?.type === "CallExpression" && key === "callee") || (parent?.type === "TaggedTemplateExpression" && key === "tag")) {
    text = `(0, ${expression})`;
  }
  return { start: node.start, end: node.end, text };
}

function requireSpecifier(ref) {
  const { parent, key } = ref;
  if (parent?.type !== "CallExpression" || key !== "callee" || parent.arguments.length !== 1) return null;
  const arg = parent.arguments[0];
  if (arg.type === "Literal" && typeof arg.value === "string") return arg.value;
  if (arg.type === "TemplateLiteral" && arg.expressions.length === 0) return arg.quasis[0].value.cooked;
  return null;
}

/**
 * 分析一個要搬出去的本體:最上層名字改寫成經過接橋、__dirname / __filename 改讀 globalThis,
 * 收集 require 的模組名稱;遇到不能搬的用法就失敗。
 */
function analyseBody(wrapper, source, topNames, options) {
  const { fn, rel } = wrapper;
  const body = source.slice(fn.body.start + 1, fn.body.end - 1);
  for (const name of RESERVED) {
    if (new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(body)) {
      throw new SplitError(`${rel} 的本體裡已經有 \`${name}\`,跟拆分用的名字衝突。`);
    }
  }

  const edits = [];
  const bridged = new Set();
  const requires = new Map();
  // import.meta 在 .cjs 裡是語法錯誤,要等第一次載入那個 chunk 才會發現,直接失敗。
  // 字面值的 import("…") 照 require 的規則檢查(放進同一份清單,但不算選用:import() 的失敗是
  // rejected promise,try 不一定接得到);相對路徑搬出去之後會改成相對於 server/chunks/ 解析,
  // 所以失敗。不是字面值的 import(…) 維持原樣(Next 只在開發模式走那條路)。
  walk(fn.body, (node) => {
    if (node.type === "MetaProperty" && node.meta.name === "import") {
      throw new SplitError(`${rel} 用到 import.meta;搬成 CommonJS 模組之後是語法錯誤。`);
    }
    if (node.type === "ImportExpression") {
      const src = node.source;
      const specifier =
        src.type === "Literal" && typeof src.value === "string"
          ? src.value
          : src.type === "TemplateLiteral" && src.expressions.length === 0
            ? src.quasis[0].value.cooked
            : null;
      if (specifier !== null) requires.set(specifier, { optionalOnly: false });
    }
    return true;
  });
  forEachFreeReference(fn, (ref) => {
    const name = ref.node.name;
    if (name === "arguments") {
      if (ref.argumentsOfRoot) throw new SplitError(`${rel} 用到包裝函式自己的 arguments;搬出去之後參數不同。`);
      return;
    }
    if (topNames.has(name)) {
      if (isWrite(ref)) throw new SplitError(`${rel} 寫入 bundle 最上層的 \`${name}\`;接橋只能讀。`);
      bridged.add(name);
      edits.push(rewriteEdit(ref, `${SCOPE_NAME}.${name}`));
      return;
    }
    if (FAIL_NAMES.has(name)) {
      throw new SplitError(
        `${rel} 在自由範圍用到 \`${name}\`。搬成 CommonJS 模組之後,這個名字會指向那個模組自己的 ${name},` +
          "跟原本在 bundle 裡的意思不同。",
      );
    }
    if (GLOBAL_LOOKUP_NAMES.has(name)) {
      if (isWrite(ref)) throw new SplitError(`${rel} 寫入 \`${name}\`。`);
      edits.push(rewriteEdit(ref, `globalThis.${name}`));
      return;
    }
    if (name === "require") {
      const specifier = requireSpecifier(ref);
      if (specifier === null) {
        throw new SplitError(
          `${rel} 用 require 的方式不是 \`require("<模組名稱>")\`;搬出去之後 require 是 workerd 的` +
            " CommonJS require,不經過 wrangler 的打包,只能確認字面值的模組名稱。",
        );
      }
      const seen = requires.get(specifier);
      requires.set(specifier, { optionalOnly: (seen ? seen.optionalOnly : true) && ref.inTry });
      return;
    }
    if (options.injectedGlobals.has(name)) {
      throw new SplitError(
        `${rel} 用到全域的 \`${name}\`。相容日期 ${options.compatibilityDate} 下 wrangler 打包時會注入它,` +
          "搬出去的模組不經過打包,拿不到。",
      );
    }
  });

  const offset = fn.body.start + 1;
  let rewritten = body;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, edit.start - offset) + edit.text + rewritten.slice(edit.end - offset);
  }
  return { body: rewritten, bridged, requires };
}

function chunkModuleSource(wrapper, body) {
  const [exportsParam, moduleParam] = wrapper.fn.params.map((param) => param.name);
  const params = [exportsParam ?? EXPORTS_PARAM, moduleParam ?? MODULE_PARAM, SCOPE_NAME].join(", ");
  // 原本在 ES module 裡(嚴格模式),所以搬出去也是嚴格模式。
  return `"use strict";\n// ${JSON.stringify(wrapper.key)}\nmodule.exports = function (${params}) {${body}\n};\n`;
}

function isNodeBuiltin(specifier, options) {
  return specifier.startsWith("node:") || options.nodeBuiltins.has(specifier);
}

/** 檢查搬出去的程式碼 require 的每個模組;回傳只在 try 裡 require 的選用套件。 */
function checkRequires(requiresByModule, options) {
  const problems = new Map();
  const optional = new Set();
  const note = (reason, specifier, rel) => {
    const key = `${reason}:${specifier}`;
    if (!problems.has(key)) problems.set(key, { reason, specifier, modules: [] });
    problems.get(key).modules.push(rel);
  };
  for (const [rel, specifiers] of requiresByModule) {
    for (const [specifier, { optionalOnly }] of specifiers) {
      if (/^\.{0,2}\//.test(specifier)) note("相對路徑", specifier, rel);
      else if (isNodeBuiltin(specifier, options)) {
        if (!options.nativeModules.has(specifier)) note(`相容日期 ${options.compatibilityDate} 下 workerd 不原生提供`, specifier, rel);
      } else if (optionalOnly) optional.add(specifier);
      else note("不是 Node 內建模組,也不是在會接住錯誤的 try 裡 require", specifier, rel);
    }
  }
  if (problems.size > 0) {
    const lines = [...problems.values()].map(({ reason, specifier, modules }) => {
      const list = modules.sort();
      return `${specifier}(${reason}):${list.slice(0, 3).join("、")}${list.length > 3 ? ` 等 ${list.length} 個` : ""}`;
    });
    throw new SplitError(
      "搬出去的程式碼 require / import() 了不能直接交給 workerd 的模組。原本由 wrangler 打包(unenv 別名、" +
        "打包進來的套件),搬出去之後由 workerd 解析:\n  " +
        lines.sort().join("\n  "),
    );
  }
  return [...optional].sort();
}

/**
 * 把 OpenNext 的 handler.mjs 拆成 server 模組加上每個 chunk / 路由檔各一個 CommonJS 模組。
 *
 * @param {string} source handler.mjs 的內容
 * @param {{ nativeModules: Set<string>, nodeBuiltins: Set<string>, injectedGlobals: Set<string>, compatibilityDate: string }} options
 *   nativeModules:workerd 在這個相容日期與旗標下原生提供的 Node 模組名稱(含與不含 `node:` 前綴);
 *   nodeBuiltins:不帶 `node:` 前綴也算 Node 內建模組的名稱;injectedGlobals:wrangler 打包時會注入的
 *   全域名稱。三者都取自 wrangler 用的 @cloudflare/unenv-preset。
 * @returns {{ server: string, modules: { file: string, key: string, kind: "chunk" | "route", source: string }[], bridged: string[], requires: string[], optionalRequires: string[], kept: number }}
 */
export function splitServerHandler(source, options) {
  if (!options?.nativeModules || !options?.nodeBuiltins || !options?.injectedGlobals || !options?.compatibilityDate) {
    throw new TypeError("splitServerHandler 需要 nativeModules、nodeBuiltins、injectedGlobals 與 compatibilityDate");
  }
  const program = parse(source, "server handler");
  const topNames = topLevelNames(program);

  if (!topNames.has("__commonJS")) {
    throw new SplitError("server handler 裡沒有 esbuild 的 __commonJS 輔助函式:輸出形狀跟預期不同。");
  }
  for (const name of RESERVED) {
    if (topNames.has(name)) throw new SplitError(`server handler 的最上層已經有 \`${name}\`,不能再加。`);
  }
  for (const stmt of program.body) {
    if (stmt.type === "ImportDeclaration" && /^\.\.?\//.test(stmt.source.value)) {
      throw new SplitError(`server handler 用相對路徑 import ${stmt.source.value};拆分會搬動這個檔,路徑會失效。`);
    }
  }

  const wrappers = findWrappers(program, source);
  const toSplit = wrappers.filter((wrapper) => wrapper.split);
  if (toSplit.length === 0) {
    throw new SplitError(
      `server handler 裡找不到任何 .next/server/chunks 或 .next/server/app 的 __commonJS 包裝` +
        `(共 ${wrappers.length} 個包裝)。`,
    );
  }

  const files = new Map();
  const bridged = new Set();
  const requiresByModule = new Map();
  const modules = [];
  for (const wrapper of toSplit) {
    const file = moduleFileName(wrapper.rel);
    // 不分大小寫的檔案系統(macOS 預設)上,只差大小寫的兩個檔名會互相覆蓋。
    const folded = file.toLowerCase();
    if (files.has(folded)) {
      throw new SplitError(`${files.get(folded)} 與 ${wrapper.key} 會寫成同一個檔名 ${file}(不分大小寫)。`);
    }
    files.set(folded, wrapper.key);
    const analysed = analyseBody(wrapper, source, topNames, options);
    for (const name of analysed.bridged) bridged.add(name);
    if (analysed.requires.size > 0) requiresByModule.set(wrapper.rel, analysed.requires);
    modules.push({
      file,
      key: wrapper.key,
      kind: wrapper.rel.startsWith("chunks/") ? "chunk" : "route",
      source: chunkModuleSource(wrapper, analysed.body),
      fn: wrapper.fn,
    });
  }
  const optionalRequires = checkRequires(requiresByModule, options);

  // 包裝函式(參數與本體)換成「載入搬出去的模組,呼叫它」。從後面往前換,前面的位置才不會跑掉。
  let server = source;
  for (const mod of [...modules].sort((a, b) => b.fn.start - a.fn.start)) {
    const target = JSON.stringify(`./${CHUNK_DIR}/${mod.file}`);
    const replacement =
      `(${EXPORTS_PARAM}, ${MODULE_PARAM}) { return ${REQUIRE_NAME}(${target})` +
      `(${EXPORTS_PARAM}, ${MODULE_PARAM}, ${SCOPE_NAME}); }`;
    server = server.slice(0, mod.fn.start) + replacement + server.slice(mod.fn.end);
  }

  // 檔頭:import 先於一切求值,getter 只在被讀時才取值。
  const names = [...bridged].sort();
  const header =
    `import { createRequire as ${CREATE_REQUIRE_NAME} } from "node:module";\n` +
    `const ${REQUIRE_NAME} = ${CREATE_REQUIRE_NAME}(import.meta.url);\n` +
    `const ${SCOPE_NAME} = Object.freeze({${names.map((name) => ` get ${name}() { return ${name}; }`).join(",")} });\n`;

  return {
    server: header + server,
    modules: modules
      .map(({ file, key, kind, source: text }) => ({ file, key, kind, source: text }))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)),
    bridged: names,
    requires: [...new Set([...requiresByModule.values()].flatMap((map) => [...map.keys()]))].sort(),
    optionalRequires,
    kept: wrappers.length - toSplit.length,
  };
}
