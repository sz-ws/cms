import {
  DOMAIN_RE,
  hashScripts,
  parseScriptsApproval,
  scriptHosts,
  type ScriptSourceLike,
} from "../ext/dx/scripts-core";

// [core] 公開頁 CSP 的主機白名單怎麼從 declarative_extensions 的列算出來。
//
// 啟用中、而且核准紀錄對得上目前內容的宣告式插件 scripts,它們的 src 主機與宣告的
// domains。判斷與 ext/dx/scripts-widget.tsx 同一條(hash 對不上就不渲染 = 也不放行)。
//
// 從 public-csp.ts 拆出來,因為現在有三個地方算同一份清單,規則只能有一份:
//   - middleware(public-csp.ts):KV 副本沒帶清單時,自己問 D1
//   - 版本戳的 KV 副本(stamps.ts):發布與補寫時一起算好,冷的 isolate 的 middleware
//     直接拿,不必再打一趟 D1
//   - 冷啟動的合併讀取(cold-snapshot.ts):從它已經讀回來的整張表算
// 零依賴(只用 scripts-core,用相對路徑:Worker 入口 custom-worker.ts 經 stamps.ts 載入這個
// 檔,那一層不經過 Next 的 `@/` alias),middleware 的 edge bundle 也能載入。manifest 裡的 scripts
// 安裝時已經過 zod;這裡只做「形狀對、值合規」的最小檢查,因為結果會寫進回應標頭。

// 1.57.0:啟用中的 Firebase 登入(loginProvider.firebase)也要一台主機 —— Firebase SDK 的
// 登入視窗要從 apis.google.com 載入 Google 的 gapi 載入器。沒有 Firebase 登入的站不放行。
export const APPROVED_SCRIPTS_SQL = `SELECT json_extract(manifest, '$.scripts') AS scripts, scripts_approval AS approval,
  json_extract(manifest, '$.loginProvider.firebase') IS NOT NULL AS firebase
  FROM declarative_extensions
  WHERE enabled = 1 AND (scripts_approval IS NOT NULL OR json_extract(manifest, '$.loginProvider.firebase') IS NOT NULL)`;

/** Firebase 登入視窗要載入程式的主機(SDK 的 gapi 載入器)。 */
export const FIREBASE_SCRIPT_HOSTS = ["apis.google.com"] as const;

export interface ApprovedScriptsRow {
  /** manifest.scripts:SQL 的 json_extract 給的是 JSON 字串,已經 parse 過的陣列也收。 */
  scripts: unknown;
  approval: string | null;
  /** 1.57.0:這個插件宣告了 Firebase 登入(SQL 給 0/1)。 */
  firebase?: unknown;
}

/** CSP 主機的形狀:網域(可帶 `*.`)加上可選的連接埠。KV 副本讀回來時也用它擋。 */
export const SCRIPT_HOST_RE = /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?$/;

function asScripts(raw: unknown): ScriptSourceLike[] | null {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  const out: ScriptSourceLike[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") return null;
    const { src, inline, domains } = item as Record<string, unknown>;
    if (src !== undefined && typeof src !== "string") return null;
    if (inline !== undefined && typeof inline !== "string") return null;
    if (domains !== undefined && !(Array.isArray(domains) && domains.every((d) => typeof d === "string"))) {
      return null;
    }
    out.push({
      ...(src !== undefined ? { src } : {}),
      ...(inline !== undefined ? { inline } : {}),
      ...(domains !== undefined ? { domains: domains as string[] } : {}),
    });
  }
  return out;
}

/** 核准過(hash 對得上)的 scripts 會用到的主機,加上 Firebase 登入要的主機;去重、依列的順序。 */
export async function hostsFromApprovedRows(rows: readonly ApprovedScriptsRow[]): Promise<string[]> {
  const hosts: string[] = [];
  for (const row of rows) {
    if (row.firebase === true || row.firebase === 1) {
      for (const host of FIREBASE_SCRIPT_HOSTS) if (!hosts.includes(host)) hosts.push(host);
    }
    const scripts = asScripts(row.scripts);
    const approval = parseScriptsApproval(row.approval);
    if (!scripts || !approval) continue;
    if ((await hashScripts(scripts)) !== approval.hash) continue;
    for (const host of scriptHosts(scripts)) {
      // src 主機可能帶連接埠(scriptHosts 用 URL.host),domains 則只能是網域。
      const bare = host.replace(/:\d{1,5}$/, "");
      if (DOMAIN_RE.test(bare) && !hosts.includes(host)) hosts.push(host);
    }
  }
  return hosts;
}

/** 直接問 D1(一趟)。 */
export async function approvedScriptHosts(d1: D1Database): Promise<string[]> {
  const { results } = await d1.prepare(APPROVED_SCRIPTS_SQL).all<ApprovedScriptsRow>();
  return hostsFromApprovedRows(results ?? []);
}
