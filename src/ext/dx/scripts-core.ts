// 1.50.0:從 ./scripts.ts 拆出來的純邏輯 —— 核准 hash、核准紀錄、會連到的主機。
//
// 拆開的理由只有一個:公開頁的 CSP 在 middleware(edge)裡算,要知道「核准過的
// script 會從哪些主機載入」,而 ./scripts.ts 頂層就建 zod schema,import 它等於把
// 整包 zod 拉進每個請求都會跑的 middleware。這裡零依賴;./scripts.ts 原樣 re-export,
// 其他呼叫端不用改。規則仍只有一份。

/** 核准比對與主機計算只看這三個欄位(zod 驗過的 DeclarativeScript 也是這個形狀)。 */
export interface ScriptSourceLike {
  src?: string;
  inline?: string;
  domains?: string[];
}

export const ORIGIN_RE = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?/;
export const DOMAIN_RE = /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/**
 * 核准比對用的正規化字串。用陣列而不是物件:JSON 物件的 key 順序取決於 manifest
 * 怎麼寫,同一份內容換個欄位順序不該變成「內容改了」。
 */
export function canonicalScripts(scripts: readonly ScriptSourceLike[]): string {
  return JSON.stringify(
    scripts.map((s) => [s.src ?? null, s.inline ?? null, s.domains ?? []]),
  );
}

/** 核准紀錄裡存的 hash(SHA-256,hex)。Workers 與 Node 都有 crypto.subtle。 */
export async function hashScripts(scripts: readonly ScriptSourceLike[]): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalScripts(scripts));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const SCRIPTS_HASH_RE = /^[0-9a-f]{64}$/;

/** 核准畫面要列出的網域:外部 script 的主機 + 各段宣告的 domains。 */
export function scriptHosts(scripts: readonly ScriptSourceLike[]): string[] {
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
