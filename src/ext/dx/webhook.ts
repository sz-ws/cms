import { getSetting } from "@/lib/settings";
import { extSetting } from "@/lib/settings";
import { publicExtras, type ExtraFieldDef } from "@/lib/extra-fields";
import { getExtraFieldDefs } from "@/lib/extra-fields-server";
import type { DeclarativeHookAction } from "./manifest";
import type { HookHandler } from "../types";

// core-v2 §3.3 / §5:declarative "on" 綁定 → hook handler。v1 僅 webhook。
// 對目標 POST JSON { hook, payload, timestamp },帶 header
//   X-SZWS-Signature: HMAC-SHA256 hex over the raw body(secret 讀自 secretSetting)。
// 約束:https only、outbound only、5s AbortSignal timeout、失敗 console.error(絕不 throw)。

const TIMEOUT_MS = 5000;

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * content:* 的 payload 是 { type, id, data };data.extra 裡不公開的額外欄位不能送去外部
 * 網址。讀不到定義就整個 extra 拿掉 —— 寧可少送,不可多送。其他形狀的 payload 原樣。
 */
async function withoutPrivateExtras(payload: unknown): Promise<unknown> {
  if (!isRecord(payload) || typeof payload.type !== "string" || !isRecord(payload.data)) {
    return payload;
  }
  if (!Object.prototype.hasOwnProperty.call(payload.data, "extra")) return payload;
  let defs: ExtraFieldDef[] = [];
  try {
    defs = await getExtraFieldDefs(payload.type);
  } catch (e) {
    console.error("[webhook] extra field definitions unavailable; dropping extra", e);
  }
  return { ...payload, data: publicExtras(defs, payload.data) };
}

/**
 * 為單一 hook 的一組 webhook actions 建立 handler。handler 收到 hook payload(第一個參數),
 * 依序 POST 每個 action;個別失敗互不影響。
 */
export function makeWebhookHandler(
  extId: string,
  hookName: string,
  actions: DeclarativeHookAction[],
): HookHandler {
  return async (payload: unknown): Promise<void> => {
    const timestamp = Date.now();
    const body = JSON.stringify({
      hook: hookName,
      payload: await withoutPrivateExtras(payload),
      timestamp,
    });

    for (const action of actions) {
      // 防禦性:非 https 一律跳過(schema 已擋,interpret 時重驗仍保留此檢查)。
      if (!action.url.startsWith("https://")) {
        console.error(
          `[webhook:${hookName}] ext=${extId} skipped non-https url`,
        );
        continue;
      }
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (action.secretSetting) {
          const secret = await getSetting<string>(
            extSetting(extId, action.secretSetting),
            "",
          );
          if (secret) {
            headers["X-SZWS-Signature"] = await hmacHex(secret, body);
          }
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const res = await fetch(action.url, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
          });
          if (!res.ok) {
            console.error(
              `[webhook:${hookName}] ext=${extId} status=${res.status}`,
            );
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        console.error(`[webhook:${hookName}] ext=${extId}`, e);
      }
    }
  };
}
