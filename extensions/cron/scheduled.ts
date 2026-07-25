import { decryptSecretWithKey } from "../../src/lib/secret-envelope";

// cron extension 的「錶」—— 由 custom-worker.ts 的 `scheduled` handler 呼叫。
//
// 這支模組把 companion worker(worker/index.js)做的事搬進 CMS 自己的 worker:
// 依 Cloudflare cron trigger 醒來 → 讀出本 extension 的 signing secret → 對
// `POST /api/callback/cron:tick/cron` 送一個帶 HMAC-SHA256 簽章的請求。
//
// 為什麼還是走「自己打自己的 callback」而不是直接呼叫 runDueJobs():
//   - `scheduled` 沒有 request context,getCloudflareContext() 會 throw,
//     runDueJobs → db()/getSetting() 那整條 Next 相依鏈在這裡不能用。
//   - 走既有的 unified callback ingress,驗簽/rate limit/錯誤語意全部沿用同一份
//     已驗證過的程式碼,不會出現第二條「繞過驗簽」的入口。
//   - 定案不變:core 本身永遠只有 lazy sweep;secret 與 tick 入口都屬於 cron extension。
//     這個檔案住在 extensions/cron/ 就是這個意思。
//
// 硬規則:本檔只能 import ../../src/lib/secret-envelope(純 Web Crypto)。任何
// `@/` 別名 / next/* / drizzle / lib/db 都會把整個 Next module graph 拖進 worker
// 入口的 bundle —— 那是這條路線唯一會致命的失誤。D1 一律用原生 prepare/bind。

const SECRET_KEY = "ext.cron.secret";
const SITE_URL_KEY = "core.siteUrl";
const EXT_ID = "cron";
const CALLBACK_PATH = "/api/callback/cron:tick/cron";
const SIGNATURE_HEADER = "x-signature"; // hex(HMAC-SHA256),與 provider.ts 同配方

// service binding 直接把請求交給同一支 worker,host 不參與路由(且 /api/callback
// 不在 middleware matcher 內)。core.siteUrl 有設就用真實 origin,沒設就用這個佔位
// origin —— 只是為了讓 URL 合法,不會有任何對外連線。
const FALLBACK_ORIGIN = "http://cron.local";

/** `scheduled(event, env, ctx)` 拿得到的 binding 子集(全部 optional:缺就安靜跳過)。 */
export interface CronScheduledEnv {
  DB?: D1Database;
  SECRETS_KEY?: string;
  WORKER_SELF_REFERENCE?: Fetcher;
}

interface TickRow {
  secret: string | null;
  site_url: string | null;
  enabled: number | null;
}

// 一次 round-trip 取齊三件事:extension 是否啟用、加密後的 secret、站台 origin。
// (settings.value 一律是 JSON.stringify 後的字串,讀出來要先 JSON.parse。)
const TICK_QUERY = `SELECT
  (SELECT value FROM settings WHERE key = ?1) AS secret,
  (SELECT value FROM settings WHERE key = ?2) AS site_url,
  (SELECT enabled FROM extensions WHERE id = ?3) AS enabled`;

/** JSON.parse 出字串才回傳;其餘(非字串 / 壞 JSON / null)一律 null。 */
function parseJsonString(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** HMAC-SHA256(body, secret) → 小寫 hex。與 provider.ts 的 verify 配方完全一致。 */
async function sign(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
}

function originOf(siteUrl: string | null): string {
  if (!siteUrl) return FALLBACK_ORIGIN;
  try {
    return new URL(siteUrl).origin;
  } catch {
    return FALLBACK_ORIGIN;
  }
}

/**
 * 送出一次 cron tick。整支函式**絕不 throw**:cron 沒裝、沒啟用、沒設密鑰、
 * binding 缺失 —— 全部安靜 no-op(這些都是完全正常的狀態,core 的 lazy sweep 仍是保底)。
 * 只有「該送卻送失敗」才 console.error。
 */
export async function runCronTick(env: CronScheduledEnv): Promise<void> {
  const { DB, SECRETS_KEY, WORKER_SELF_REFERENCE } = env;
  // 少任何一個 binding 都不是這裡該修的問題,安靜跳過(fetch handler 自會抱怨)。
  if (!DB || !SECRETS_KEY || !WORKER_SELF_REFERENCE) return;

  let row: TickRow | null;
  try {
    row = await DB.prepare(TICK_QUERY)
      .bind(SECRET_KEY, SITE_URL_KEY, EXT_ID)
      .first<TickRow>();
  } catch (e) {
    console.error("[cron] tick query failed", e);
    return;
  }
  // extension 未安裝(row.enabled === null)或已停用 → 安靜跳過。
  if (!row || row.enabled !== 1) return;

  const stored = parseJsonString(row.secret);
  if (!stored) return; // 密鑰未設定 → 安靜跳過(對應 provider 的 fail-closed)。

  let secret: string;
  try {
    secret = await decryptSecretWithKey(SECRETS_KEY, stored);
  } catch (e) {
    // 解不開通常代表 SECRETS_KEY 被換過(信封沒有 key id,無漸進遷移路徑)。
    console.error("[cron] failed to decrypt ext.cron.secret", e);
    return;
  }
  if (!secret) return;

  const body = JSON.stringify({ ts: Date.now() });
  const url = originOf(parseJsonString(row.site_url)) + CALLBACK_PATH;
  try {
    const signature = await sign(body, secret);
    const res = await WORKER_SELF_REFERENCE.fetch(url, {
      method: "POST",
      headers: {
        [SIGNATURE_HEADER]: signature,
        "content-type": "application/json",
      },
      body,
    });
    if (!res.ok) console.error("[cron] tick rejected", res.status);
  } catch (e) {
    console.error("[cron] tick request failed", e);
  }
}
