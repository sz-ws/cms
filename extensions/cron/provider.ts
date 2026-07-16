import type { CallbackReceiver } from "@/ext/capabilities";
import type { CoreServices } from "@/ext/services";
import { runDueJobs } from "@/lib/jobs";

// cron:tick 的 CallbackReceiver provider —— 分鐘級準時排程的「安全入口」。
//
// 錶(定時器)活在外面(companion worker / 任何外部排程器),它對本站
// POST /api/callback/cron:tick/cron 送一個帶簽章的請求;此 provider 驗簽後催動
// core 的 runDueJobs()。與 core 的 lazy sweep 併存:worker 掛掉只是退回 sweep 節奏。
//
// 簽章配方與 src/ext/providers/demo-callback.ts 完全一致(HMAC-SHA256 + hex +
// crypto.subtle.verify constant-time + fail-closed),勿自創。密鑰取自本 extension
// 自己的加密 setting `ext.cron.secret`(services scope 綁定 extId="cron")。

const SECRET_KEY = "ext.cron.secret";
const LAST_TICK_KEY = "ext.cron.lastTick"; // 非 secret;admin 觀測用(epoch ms)。
const SIGNATURE_HEADER = "x-signature"; // hex(HMAC-SHA256)

/** hex 字串 → bytes;非法字元/奇數長度 → null(呼叫端當作驗證失敗)。 */
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

function utf8(s: string): Uint8Array<ArrayBuffer> {
  const src = new TextEncoder().encode(s);
  const out = new Uint8Array(new ArrayBuffer(src.length));
  out.set(src);
  return out;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

export class CronTickProvider implements CallbackReceiver {
  constructor(private readonly services: CoreServices) {}

  async verifyCallback(rawBody: string, headers: Headers): Promise<boolean> {
    const secret = await this.services.settings.get<string>(SECRET_KEY, "");
    if (!secret) return false; // fail closed:未設定密鑰不放行任何請求。

    const provided = headers.get(SIGNATURE_HEADER);
    if (!provided) return false;
    const sigBytes = hexToBytes(provided.trim().toLowerCase());
    if (!sigBytes) return false;

    const key = await importHmacKey(secret);
    // crypto.subtle.verify 對 MAC 比較為 constant-time —— 避免自寫比較洩漏長度/前綴。
    return crypto.subtle.verify({ name: "HMAC" }, key, sigBytes, utf8(rawBody));
  }

  // rawBody 內容不信任、不解析(簽章對整段 raw 已驗);tick 只是「該掃了」的訊號。
  async handleCallback(): Promise<void> {
    const reports = await runDueJobs(Date.now());
    // 逐任務報告 —— 證明 tick 確實催動了 core jobs,供 log 觀測。
    console.log("[cron:tick] ran due jobs", { reports });
    // marker setting(非 secret):admin 可讀回最後一次 tick 的 epoch ms。
    await this.services.settings.set({ [LAST_TICK_KEY]: Date.now() });
  }
}
