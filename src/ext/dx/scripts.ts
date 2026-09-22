import { z } from "zod";

// 1.48.0:宣告式插件在公開頁插入 script(manifest.scripts)。
//
// 這是宣告式唯一一個「能跑任意程式」的欄位,所以它的安全模型跟其他欄位不同:
// 其他欄位靠 schema 讓 manifest 無法做壞事,這個欄位靠**人**。安裝時管理員要看過
// 內容、明確核准,核准紀錄存的是 scripts 的 SHA-256 —— 之後 manifest 換了內容
// (更新、或有人改了 registry 上的檔),hash 對不上就不執行,等人重新核准。
//
// 這支檔案只放純邏輯(schema、正規化、hash、代入),client 與 server 都能 import。
// 渲染在 ./scripts-widget.tsx,核准的 API 在 api/extensions/[extId]/scripts。
//
// 代入符號有三種,都在伺服器端換成 JSON 字面值(同一套跳脫,見 scriptLiteral):
//   {{settings.<key>}}           這個插件自己的非機密設定
//   {{content.<type>}}           已發布的內容。自己的型別給 {id, slug, data};
//                                別的插件的型別(<extId>.<type>)只給 {id, slug, title}
//   {{feed.<extId>.<name>}}      程式碼插件宣告的公開資料(Extension.publicFeeds)
// 後兩種只能出現在 inline:它們是資料,不能決定 script 從哪裡載入。
// 核准綁的是含代入符號的範本,資料變了不必重新核准 —— 資料不是程式。

const PLACEHOLDER_RE = /\{\{\s*(settings|content|feed)\.([A-Za-z0-9_.-]+)\s*\}\}/g;

export const SETTING_REF_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
/** 自己的型別寫 local name,別的插件寫 <extId>.<type>。 */
export const CONTENT_REF_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)?$/;
export const FEED_REF_RE = /^[a-z][a-z0-9-]*\.[a-zA-Z][a-zA-Z0-9-]*$/;

/** {{content.*}} 一次最多帶幾筆(新的在前)。 */
export const CONTENT_REF_LIMIT = 50;
/** 單一代入值序列化後的上限;超過就從陣列尾端丟到放得下為止。 */
export const DATA_MAX_CHARS = 32_000;

export type ScriptRefNamespace = "settings" | "content" | "feed";

export interface ScriptRef {
  ns: ScriptRefNamespace;
  name: string;
  /** "content.sample" 這種完整寫法,也是 renderInlineScript 的 data 鍵。 */
  path: string;
}

// src 的 origin 必須寫死(不能有代入符號):代入只准出現在路徑與查詢字串。否則
// 設定值就能決定 script 從哪個主機載入,核准的內容等於沒有意義。
const SRC_RE = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?\/[^\s"'<>\\]*$/;
const ORIGIN_RE = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?/;
const DOMAIN_RE = /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

// inline 內容會原樣放進 <script>…</script>。`</script` 會提早關掉標籤、後面變成
// HTML;`<!--` 在 script 裡會進入舊式註解解析狀態。作者本來就能跑任意程式,擋這兩個
// 不是為了防作者,是為了不讓一個手誤把整頁的 HTML 結構弄壞。
const INLINE_FORBIDDEN_RE = /<\/script|<!--/i;

export const scriptEntrySchema = z
  .object({
    /** 外部 script 的網址(https)。會以 `<script async>` 載入。 */
    src: z
      .string()
      .max(2048)
      .regex(SRC_RE, "script src must be an https URL with a fixed host")
      .optional(),
    /** 直接寫在頁面裡的程式碼。 */
    inline: z
      .string()
      .min(1)
      .max(10_000)
      .refine((code) => !INLINE_FORBIDDEN_RE.test(code), {
        message: "inline script must not contain </script or <!--",
      })
      .optional(),
    /** 這段 script 還會連到的網域(顯示在核准畫面;之後 CSP 開始攔截時用來放行)。 */
    domains: z
      .array(z.string().regex(DOMAIN_RE, "invalid domain"))
      .max(8)
      .optional(),
  })
  .strict()
  .refine((s) => (s.src === undefined) !== (s.inline === undefined), {
    message: "a script needs exactly one of src or inline",
  });

export const scriptsSchema = z.array(scriptEntrySchema).min(1).max(4);

export type DeclarativeScript = z.infer<typeof scriptEntrySchema>;

/** 一段 script 用到的代入符號(依出現順序、去重)。 */
export function scriptRefs(text: string): ScriptRef[] {
  const refs: ScriptRef[] = [];
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const ns = match[1] as ScriptRefNamespace;
    const path = `${ns}.${match[2]}`;
    if (!refs.some((r) => r.path === path)) refs.push({ ns, name: match[2], path });
  }
  return refs;
}

/** 整組 scripts 用到的代入符號。 */
export function allScriptRefs(scripts: readonly DeclarativeScript[]): ScriptRef[] {
  const refs: ScriptRef[] = [];
  for (const s of scripts) {
    for (const ref of scriptRefs(s.src ?? s.inline ?? "")) {
      if (!refs.some((r) => r.path === ref.path)) refs.push(ref);
    }
  }
  return refs;
}

/** 整組 scripts 用到的設定 key。 */
export function scriptSettingKeys(scripts: readonly DeclarativeScript[]): string[] {
  return allScriptRefs(scripts)
    .filter((r) => r.ns === "settings")
    .map((r) => r.name);
}

/**
 * 代入值的大小上限:陣列就從尾端丟到放得下(內容與 feed 都是新的在前),
 * 其他型別放不下就給 null。一個行銷浮層不該讓每一頁多出幾百 KB。
 */
export function capScriptData(value: unknown): unknown {
  const fits = (v: unknown) => (JSON.stringify(v) ?? "null").length <= DATA_MAX_CHARS;
  if (fits(value)) return value;
  if (!Array.isArray(value)) return null;
  let items = value.slice(0, CONTENT_REF_LIMIT);
  while (items.length > 0 && !fits(items)) items = items.slice(0, Math.floor(items.length / 2));
  return items;
}

/**
 * 核准比對用的正規化字串。用陣列而不是物件:JSON 物件的 key 順序取決於 manifest
 * 怎麼寫,同一份內容換個欄位順序不該變成「內容改了」。
 */
export function canonicalScripts(scripts: readonly DeclarativeScript[]): string {
  return JSON.stringify(
    scripts.map((s) => [s.src ?? null, s.inline ?? null, s.domains ?? []]),
  );
}

/** 核准紀錄裡存的 hash(SHA-256,hex)。Workers 與 Node 都有 crypto.subtle。 */
export async function hashScripts(scripts: readonly DeclarativeScript[]): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalScripts(scripts));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const SCRIPTS_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * 把一個設定值變成可以放進任何 JS 位置的字面值。
 *
 * JSON.stringify 之後再把「在某些位置會有特殊意義」的字元改寫成 \uXXXX:
 *   '  `  —— 作者把 {{…}} 寫在單引號或反引號字串裡時,值不能把字串關掉
 *   $      —— 反引號字串裡的 ${…}
 *   < > &  —— </script> 與 HTML 解析
 *   / *    —— 寫在註解裡時的 * / 與 //
 *   U+2028 / U+2029 —— 舊引擎把它們當換行
 * 這些 \u 跳脫在 JSON 字串與 JS 字串裡意義相同,所以值本身不變。
 */
export function scriptLiteral(value: unknown): string {
  const json = JSON.stringify(value === undefined ? null : value) ?? "null";
  return json.replace(/[<>&'`$\/*\u2028\u2029]/g, (ch) =>
    `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * inline script 代入。settings 以 key 查;content / feed 以完整路徑查
 * (`data["content.sample"]`),查不到一律是 null。
 */
export function renderInlineScript(
  code: string,
  settings: Record<string, unknown>,
  data: Record<string, unknown> = {},
): string {
  return code.replace(PLACEHOLDER_RE, (_, ns: ScriptRefNamespace, name: string) =>
    scriptLiteral(ns === "settings" ? settings[name] : data[`${ns}.${name}`]),
  );
}

/**
 * src 代入設定值(encodeURIComponent)。結果的 host 必須跟範本寫死的一樣,否則回
 * null —— 正常情況 schema 已經保證,這裡是最後一道。
 */
export function renderScriptSrc(template: string, values: Record<string, unknown>): string | null {
  const origin = template.match(ORIGIN_RE)?.[0];
  if (!origin) return null;
  // src 只收 settings;content / feed 出現在這裡代表 manifest 沒過驗證就進來了。
  if (scriptRefs(template).some((r) => r.ns !== "settings")) return null;
  const rendered = template.replace(PLACEHOLDER_RE, (_, _ns: string, key: string) => {
    const value = values[key];
    return encodeURIComponent(value === undefined || value === null ? "" : String(value));
  });
  try {
    const url = new URL(rendered);
    if (url.protocol !== "https:" || url.origin !== new URL(origin).origin) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** 核准畫面要列出的網域:外部 script 的主機 + 各段宣告的 domains。 */
export function scriptHosts(scripts: readonly DeclarativeScript[]): string[] {
  const hosts: string[] = [];
  const add = (host: string) => {
    if (!hosts.includes(host)) hosts.push(host);
  };
  for (const s of scripts) {
    const origin = s.src?.match(ORIGIN_RE)?.[0];
    if (origin) add(new URL(origin).host);
    for (const d of s.domains ?? []) add(d);
  }
  return hosts;
}

export interface ScriptsApproval {
  /** 核准當下 scripts 的 hashScripts()。 */
  hash: string;
  /** 核准者的 email。 */
  by: string;
  /** 核准時間(ms)。 */
  at: number;
}

/** declarative_extensions.scripts_approval 欄位 → 核准紀錄;格式不對一律當成沒核准。 */
export function parseScriptsApproval(raw: string | null | undefined): ScriptsApproval | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ScriptsApproval>;
    if (
      typeof v.hash === "string" &&
      SCRIPTS_HASH_RE.test(v.hash) &&
      typeof v.by === "string" &&
      typeof v.at === "number"
    ) {
      return { hash: v.hash, by: v.by, at: v.at };
    }
  } catch {
    // 落到下面:當成沒核准。
  }
  return null;
}
