import { getSetting, setSettings } from "@/lib/settings";
import type { CallbackReceiver } from "../capabilities";
import type { HookBus } from "../hooks";

// core-v2 §2.5 — DEMO ONLY callback provider。
//
// ⚠️ 這是為了讓「unified callback ingress」能端到端 smoke-test 而存在的 **範例** provider。
//    真實的 payment(stripe)/ doc-extraction(extend-ai)/ OAuth provider 以完全相同的方式
//    plug-in:實作 CallbackReceiver、註冊到 ProviderRegistry(此處或 code extension 的
//    `provides`)。上線接入真實 provider 後,連同 core.demoCallbackSecret setting 一併移除。
//
// capability = "demo-callback",id = "echo"。
//
// verifyCallback:HMAC-SHA256(rawBody, secret) 與請求 header `x-signature`(hex)比對。
//   - 密鑰取自加密 settings `core.demoCallbackSecret`(secret:true;§5 secrets 加密)。
//   - 以 crypto.subtle.verify 做 **constant-time** 比較(§5 timing-safe;避免自寫比較洩漏
//     長度/前綴資訊)。密鑰未設定 → 一律 false(fail closed)。
//   - rawBody 為未經 JSON.parse 的原始字串(§5 raw body preserved;route 已保證只讀一次)。
// handleCallback:寫一個 marker setting + 觸發 payment:succeeded hook(僅在 verify 通過後)。

const SECRET_SETTING = "core.demoCallbackSecret";
const MARKER_SETTING = "core.demoCallbackLastEvent"; // 非 secret;smoke-test 觀測用。
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

export class DemoCallbackProvider implements CallbackReceiver {
  constructor(private readonly hooks: HookBus) {}

  async verifyCallback(rawBody: string, headers: Headers): Promise<boolean> {
    const secret = await getSetting<string>(SECRET_SETTING, "");
    if (!secret) return false; // fail closed:未設定密鑰不放行任何請求。

    const provided = headers.get(SIGNATURE_HEADER);
    if (!provided) return false;
    const sigBytes = hexToBytes(provided.trim().toLowerCase());
    if (!sigBytes) return false;

    const key = await importHmacKey(secret);
    // crypto.subtle.verify 對 MAC 比較為 constant-time —— §5 timing-safe 要求。
    return crypto.subtle.verify(
      { name: "HMAC" },
      key,
      sigBytes,
      utf8(rawBody),
    );
  }

  async handleCallback(rawBody: string, headers: Headers): Promise<void> {
    // 已驗證事件:寫 marker(smoke-test 可讀回)+ 觸發 hook 供其他 extension 反應。
    // rawBody 可能非 JSON(demo 不假設格式);安全解析,失敗則存原字串。
    let event: unknown = rawBody;
    try {
      event = JSON.parse(rawBody);
    } catch {
      // 保留原字串(demo 容忍非 JSON payload)。
    }
    await setSettings({
      [MARKER_SETTING]: JSON.stringify({ at: Date.now(), event }),
    });
    // DEMO log —— 證明 handler 確實跑到(真實 provider 用結構化 logging)。
    // 真實 provider 常從 header 取 event type / delivery id;此處記錄 content-type 示範用途。
    console.log("[demo-callback:echo] handled verified callback", {
      bytes: rawBody.length,
      contentType: headers.get("content-type") ?? "",
    });
    await this.hooks.doAction("payment:succeeded", {
      providerId: "echo",
      event,
    });
  }
}
