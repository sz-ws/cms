import { getEnv } from "@/lib/cf";
import { getSetting } from "@/lib/settings";
import {
  validRecipients,
  type EmailMessage,
  type EmailProvider,
  type EmailSendResult,
} from "./email";

// 1.44.0:email:send 的第二個內建 provider —— Cloudflare Email Service。
//
// 走 Worker 的 send_email 綁定(https://developers.cloudflare.com/email-service/),
// 不用 API key:wrangler.jsonc 加 `"send_email": [{ "name": "EMAIL" }]`,寄件網域
// 在 Cloudflare 後台驗證過就能寄。沒有綁定 → not_configured(跟 Resend 缺 key 一樣)。
//
// 在 registry 以 id "cloudflare" 註冊(providers.ts);設定頁的「寄信服務」寫
// core.provider.email:send 切換。錯誤是帶 code 的 Error(E_SENDER_NOT_VERIFIED、
// E_RATE_LIMIT_EXCEEDED…),code 放進 detail,只給 server 端記錄。

export const CLOUDFLARE_EMAIL_BINDING = "EMAIL";

interface CloudflareAddress {
  email: string;
  name?: string;
}

interface CloudflareSendEmail {
  send(message: {
    to: string[];
    from: string | CloudflareAddress;
    subject: string;
    html?: string;
    text?: string;
    replyTo?: string;
  }): Promise<{ messageId?: string } | undefined>;
}

/** core.emailFrom 的 "Acme <noreply@acme.tw>" → { name, email };純地址原樣回傳。 */
export function parseFromAddress(raw: string): string | CloudflareAddress {
  const wrapped = /^\s*(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(raw);
  if (!wrapped) return raw.trim();
  const name = wrapped[1].replace(/^"(.*)"$/, "$1").trim();
  return name ? { email: wrapped[2], name } : wrapped[2];
}

function sendBinding(): CloudflareSendEmail | null {
  try {
    const env = getEnv() as unknown as Record<string, unknown>;
    const candidate = env[CLOUDFLARE_EMAIL_BINDING] as Partial<CloudflareSendEmail> | undefined;
    return candidate && typeof candidate.send === "function"
      ? (candidate as CloudflareSendEmail)
      : null;
  } catch {
    // 沒有 request context(測試、build 期):當成沒綁定。
    return null;
  }
}

export class CloudflareEmailProvider implements EmailProvider {
  /** 寄件地址與 EMAIL 綁定都有。 */
  async isConfigured(): Promise<boolean> {
    const from = await getSetting<string>("core.emailFrom", "");
    return sendBinding() !== null && typeof from === "string" && from.trim() !== "";
  }

  async send(msg: EmailMessage): Promise<EmailSendResult> {
    const to = validRecipients(msg);
    if (!to) return { ok: false, error: "invalid_message" };

    const binding = sendBinding();
    const from = msg.from ?? (await getSetting<string>("core.emailFrom", ""));
    if (!binding || !from.trim()) return { ok: false, error: "not_configured" };

    try {
      const result = await binding.send({
        to,
        from: parseFromAddress(from),
        subject: msg.subject,
        ...(msg.html ? { html: msg.html } : {}),
        ...(msg.text ? { text: msg.text } : {}),
        ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
      });
      return { ok: true, id: result?.messageId ?? null };
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      const message = e instanceof Error ? e.message : "";
      return {
        ok: false,
        error: "provider_error",
        detail: `cloudflare ${typeof code === "string" ? code : "error"}${message ? `: ${message}` : ""}`,
      };
    }
  }
}
