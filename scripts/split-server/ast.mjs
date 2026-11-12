// 拆分用到的 AST 小工具:解析、走訪、判斷一個識別字是不是在引用變數、取出宣告的名字。
import * as acorn from "acorn";

export class SplitError extends Error {
  constructor(message) {
    super(message);
    this.name = "SplitError";
  }
}

export function parse(source, what) {
  try {
    return acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    throw new SplitError(`${what} 無法解析:${error.message}`);
  }
}

/** 一個節點的子節點,依原始碼順序。 */
export function childNodes(node) {
  const children = [];
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === "string") children.push({ node: child, key });
    } else if (value && typeof value.type === "string") {
      children.push({ node: value, key });
    }
  }
  return children;
}

/**
 * 逐一走訪 AST 節點(用堆疊,不遞迴:16 MB 的 bundle 會超過呼叫堆疊)。
 * visit 回傳 false 時不走進這個節點的子節點。
 */
export function walk(root, visit) {
  const stack = [{ node: root, parent: null, key: null }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (visit(item.node, item.parent, item.key) === false) continue;
    for (const child of childNodes(item.node)) stack.push({ node: child.node, parent: item.node, key: child.key });
  }
}

/** 這個 Identifier 是不是在「引用一個變數」的位置(而不是屬性名、標籤之類)。宣告的位置也算。 */
export function isReference(parent, key) {
  if (!parent) return true;
  switch (parent.type) {
    case "MemberExpression":
      return key !== "property" || parent.computed;
    case "Property":
    case "MethodDefinition":
    case "PropertyDefinition":
      return key !== "key" || parent.computed;
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return key !== "label";
    case "MetaProperty":
    case "ImportSpecifier":
    case "ExportSpecifier":
      return false;
    default:
      return true;
  }
}

/** 一個宣告樣式(`a`、`{ a, b: [c] }`、`d = 1`、`...e`)宣告的所有名字。預設值裡的是引用,不算。 */
export function bindingNames(pattern) {
  const names = [];
  const stack = [pattern];
  while (stack.length > 0) {
    const node = stack.pop();
    switch (node.type) {
      case "Identifier":
        names.push(node.name);
        break;
      case "ObjectPattern":
        for (const prop of node.properties) stack.push(prop.type === "RestElement" ? prop.argument : prop.value);
        break;
      case "ArrayPattern":
        for (const element of node.elements) if (element) stack.push(element);
        break;
      case "AssignmentPattern":
        stack.push(node.left);
        break;
      case "RestElement":
        stack.push(node.argument);
        break;
      default:
        break;
    }
  }
  return names;
}

export const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
