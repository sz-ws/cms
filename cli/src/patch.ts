// extensions/registry.ts patch 邏輯 —— 純函式,可單元測試。
//
// 現有格式穩定,直接 regex(spec §Patch 策略):
//   - import 名 = camelCase(id)(manifest id 允許連字號,JS 識別字不行)
//   - 錨定「最後一個 import 語句」(named / type / side-effect 皆算)插在其後,永不重排
//   - 解析 `export const registry: Extension[] = [...];`,末端加入 ident
//   - 兩者都已在 → 完全不動(idempotent)

/** manifest id(可含連字號) → JS 識別字(camelCase)。 */
export function camelCaseId(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export interface PatchSuccess {
  ok: true;
  content: string;
  importAdded: boolean;
  arrayAdded: boolean;
  /** true 當 import 與陣列都已存在,檔案完全未動。 */
  alreadyUpToDate: boolean;
}

export interface PatchFailure {
  ok: false;
  /** no-imports:找不到任何 import 語句可錨定;no-array:registry 陣列格式辨識不出來。 */
  reason: "no-imports" | "no-array";
  importLine: string;
  /** 要加進 registry 陣列的識別字(給人工 patch 提示用)。 */
  ident: string;
}

export type PatchResult = PatchSuccess | PatchFailure;

const REGISTRY_ARRAY_RE =
  /export const registry: Extension\[\] = \[([^\]]*)\];/;

/**
 * 把 <id> 接進 registry.ts 內容。回傳新內容或格式辨識失敗。
 * 不做磁碟 I/O —— 呼叫端負責讀寫。
 */
export function patchRegistryContent(content: string, id: string): PatchResult {
  const ident = camelCaseId(id);
  const importLine = `import { ${ident} } from "./${id}";`;
  let out = content;
  let importAdded = false;
  let arrayAdded = false;

  // ---- import ----
  if (!out.includes(importLine)) {
    const imports = [...out.matchAll(/^import .*;$/gm)];
    const last = imports.at(-1);
    if (!last || last.index === undefined) {
      return { ok: false, reason: "no-imports", importLine, ident };
    }
    const pos = last.index + last[0].length;
    out = `${out.slice(0, pos)}\n${importLine}${out.slice(pos)}`;
    importAdded = true;
  }

  // ---- registry 陣列 ----
  const arrayMatch = out.match(REGISTRY_ARRAY_RE);
  if (!arrayMatch) {
    return { ok: false, reason: "no-array", importLine, ident };
  }
  const inner = arrayMatch[1];
  // spec 用 inner.includes(ident);改用 word-boundary 避免子字串誤判
  // (例:ident "pay" 不該因既有 "newebpay" 而被當成已存在)。idempotent 意圖不變。
  const identPresent = new RegExp(`\\b${ident}\\b`).test(inner);
  if (!identPresent) {
    const trimmed = inner.trimEnd();
    const newInner = trimmed + (trimmed ? ", " : "") + ident;
    out = out.replace(
      arrayMatch[0],
      `export const registry: Extension[] = [${newInner}];`,
    );
    arrayAdded = true;
  }

  return {
    ok: true,
    content: out,
    importAdded,
    arrayAdded,
    alreadyUpToDate: !importAdded && !arrayAdded,
  };
}
