// 範圍分析:走訪一個函式,對每個「在這個函式裡沒有綁定」的識別字引用呼叫 onFree。
//
// 搬出去的模組要知道本體在自由範圍用到哪些名字:bundle 最上層的名字要接橋,`module`、`require`
// 這類名字在 CommonJS 模組裡的意思跟原本不同。所以要分得出一個名字是區域變數,還是往外找。
//
// 範圍照 ES 的規則:函式(參數、整個函式裡的 var,函式運算式自己的名字)、區塊(直接寫在區塊裡的
// let / const / class / function)、for 迴圈開頭的 let / const、switch、catch 參數、具名的 class 運算式、
// class 的 `static {}` 區塊(自己的 var 範圍)。參數不全是單純名字(有預設值、解構、rest)時,參數
// 自成一個範圍,看不到本體的 var(`function f(a = T) { var T }` 的預設值讀的是外面的 T),本體的 var
// 放在本體區塊。搬出去的程式碼原本在 ES module 裡,是嚴格模式,所以區塊裡的 function 宣告只在區塊內有效。
import { FUNCTION_TYPES, bindingNames, childNodes, isReference, walk } from "./ast.mjs";

function lexicalNames(statements, into) {
  for (const stmt of statements) {
    if (stmt.type === "VariableDeclaration" && stmt.kind !== "var") {
      for (const decl of stmt.declarations) into.push(...bindingNames(decl.id));
    } else if ((stmt.type === "ClassDeclaration" || stmt.type === "FunctionDeclaration") && stmt.id) {
      into.push(stmt.id.name);
    }
  }
}

/** 一個 var 範圍(函式本體或 static 區塊)裡所有的 var:穿過區塊,不進巢狀函式與 static 區塊。 */
function hoistedVars(body) {
  const names = [];
  walk(body, (node) => {
    if (node !== body && (FUNCTION_TYPES.has(node.type) || node.type === "StaticBlock")) return false;
    if (node.type === "VariableDeclaration" && node.kind === "var") {
      for (const decl of node.declarations) names.push(...bindingNames(decl.id));
    }
    return true;
  });
  return names;
}

function hasSimpleParams(fn) {
  return fn.params.every((param) => param.type === "Identifier");
}

/** 這個節點開出的新範圍宣告了哪些名字;不開範圍的節點回傳 null。parent / key 用來認出函式本體。 */
function scopeNames(node, parent, key) {
  const names = [];
  switch (node.type) {
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      for (const param of node.params) names.push(...bindingNames(param));
      if (node.type === "FunctionExpression" && node.id) names.push(node.id.name);
      if (node.body.type === "BlockStatement" && hasSimpleParams(node)) names.push(...hoistedVars(node.body));
      return names;
    case "BlockStatement":
      lexicalNames(node.body, names);
      // 參數不單純的函式:本體的 var 屬於本體,參數的預設值看不到。
      if (parent && FUNCTION_TYPES.has(parent.type) && key === "body" && !hasSimpleParams(parent)) {
        names.push(...hoistedVars(node));
      }
      return names;
    case "StaticBlock":
      lexicalNames(node.body, names);
      names.push(...hoistedVars(node));
      return names;
    case "SwitchStatement":
      for (const branch of node.cases) lexicalNames(branch.consequent, names);
      return names;
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement": {
      const head = node.type === "ForStatement" ? node.init : node.left;
      if (head && head.type === "VariableDeclaration" && head.kind !== "var") lexicalNames([head], names);
      return names;
    }
    case "CatchClause":
      if (node.param) names.push(...bindingNames(node.param));
      return names;
    case "ClassExpression":
      if (node.id) names.push(node.id.name);
      return names;
    default:
      return null;
  }
}

/**
 * 走訪 fn,對每個沒有在 fn 之內綁定的識別字引用呼叫
 * `onFree({ node, parent, key, grandparent, argumentsOfRoot })`。
 * `argumentsOfRoot`:這個引用是 `arguments`,而且指的是 fn 自己的 arguments(中間只隔著箭頭函式)。
 * `inTry`:這個引用在同一個函式裡某個 try 區塊之內,而且那個 try 有 catch、catch 的最上層沒有
 * throw(錯誤被接住,不會再丟出去)。只有 finally、或 catch 直接 throw 的 try 不算。
 */
export function forEachFreeReference(fn, onFree) {
  const stack = [{ node: fn, parent: null, key: null, grandparent: null, scope: null, inTry: false }];
  while (stack.length > 0) {
    const item = stack.pop();
    const { node } = item;
    let scope = item.scope;
    const names = scopeNames(node, item.parent, item.key);
    if (names) {
      scope = {
        names: new Set(names),
        parent: scope,
        fn: FUNCTION_TYPES.has(node.type),
        arrow: node.type === "ArrowFunctionExpression",
        root: node === fn,
      };
    }
    if (node.type === "Identifier" && isReference(item.parent, item.key) && !isBound(node.name, scope)) {
      onFree({
        node,
        parent: item.parent,
        key: item.key,
        grandparent: item.grandparent,
        argumentsOfRoot: node.name === "arguments" && nearestNonArrowFunction(scope)?.root === true,
        inTry: item.inTry,
      });
    }
    for (const child of childNodes(node)) {
      const inTry = FUNCTION_TYPES.has(node.type)
        ? false
        : item.inTry || (node.type === "TryStatement" && child.key === "block" && swallows(node.handler));
      stack.push({ node: child.node, parent: node, key: child.key, grandparent: item.parent, scope, inTry });
    }
  }
}

function isBound(name, scope) {
  for (let s = scope; s; s = s.parent) if (s.names.has(name)) return true;
  return false;
}

function nearestNonArrowFunction(scope) {
  for (let s = scope; s; s = s.parent) if (s.fn && !s.arrow) return s;
  return null;
}

/** catch 有接住錯誤:有 catch,而且 catch 本體的最上層沒有 throw。 */
function swallows(handler) {
  return Boolean(handler) && !handler.body.body.some((stmt) => stmt.type === "ThrowStatement");
}
