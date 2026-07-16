import { getSetting } from "@/lib/settings";

// core email:send capability(roadmap:Email provider)。
//
// 介面住在 provider 模組、不進 capabilities.ts —— Capability 是 open union
// (capabilities.ts:6),新 capability 名免改 core;registry.get<T>() 泛型取用。
// 內建 provider 走 Resend HTTP API:純 fetch、零新 binding、零新相依 ——
// 這是「core 內建 email」的形狀;SMTP/IMAP 等重管線永遠屬 extension 層
// (以自己的 id 註冊同一 capability,使用者用 core.provider.email:send 切換)。
//
// v1 只做 outbound。inbound(送達/退信 webhook)之後讓本 provider 實作
// CallbackReceiver 即可 —— /api/callback/email:send/core 的路由已存在,零改動。

export interface EmailMessage {
  to: string | string[];
  subject: string;
  /** html / text 至少一個。 */
  html?: string;
  text?: string;
  /** 省略 → 讀 core.emailFrom 設定。 */
  from?: string;
  replyTo?: string;
}

export type EmailSendResult =
  | { ok: true; id: string | null }
  | {
      ok: false;
      error: "not_configured" | "invalid_message" | "provider_error";
      detail?: string;
    };

/** provider 帳號下的一個寄信網域(listDomains 用)。 */
export interface EmailDomain {
  name: string;
  verified: boolean;
}

export interface EmailProvider {
  send(msg: EmailMessage): Promise<EmailSendResult>;
  /**
   * 可選:列出 provider 帳號下的寄信網域(admin settings 的 from-address 後綴
   * 提示用)。未設定 / 不支援 / 查詢失敗 → null(呼叫端把 null 當「沒提示可給」,
   * 絕不阻斷 settings 頁)。
   */
  listDomains?(): Promise<EmailDomain[] | null>;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_DOMAINS_ENDPOINT = "https://api.resend.com/domains";
const SEND_TIMEOUT_MS = 15_000;
const DOMAINS_TIMEOUT_MS = 8_000;

export class ResendEmailProvider implements EmailProvider {
  async send(msg: EmailMessage): Promise<EmailSendResult> {
    const to = Array.isArray(msg.to) ? msg.to : [msg.to];
    if (
      to.length === 0 ||
      to.some((a) => !a.trim()) ||
      !msg.subject.trim() ||
      (!msg.html && !msg.text)
    ) {
      return { ok: false, error: "invalid_message" };
    }

    // apiKey 是 secret 欄位 —— getSetting 已透過 AES-GCM 管線解密回明文。
    const apiKey = await getSetting<string>("core.resendApiKey", "");
    const from = msg.from ?? (await getSetting<string>("core.emailFrom", ""));
    if (!apiKey || !from) {
      return { ok: false, error: "not_configured" };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to,
          subject: msg.subject,
          ...(msg.html ? { html: msg.html } : {}),
          ...(msg.text ? { text: msg.text } : {}),
          ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Resend 錯誤體:{ name, message }。detail 只進 server-side 呼叫端,
        // 不直達使用者;UI 層自行轉譯。
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        return {
          ok: false,
          error: "provider_error",
          detail: `resend ${res.status}${body?.message ? `: ${body.message}` : ""}`,
        };
      }

      const body = (await res.json().catch(() => null)) as {
        id?: string;
      } | null;
      return { ok: true, id: body?.id ?? null };
    } catch (e) {
      return {
        ok: false,
        error: "provider_error",
        detail:
          e instanceof Error && e.name === "AbortError"
            ? "timeout"
            : "network_error",
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async listDomains(): Promise<EmailDomain[] | null> {
    const apiKey = await getSetting<string>("core.resendApiKey", "");
    if (!apiKey) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOMAINS_TIMEOUT_MS);
    try {
      const res = await fetch(RESEND_DOMAINS_ENDPOINT, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      // Resend GET /domains:{ data: [{ name, status, ... }] };
      // status: "verified" | "pending" | "not_started" | "failed" 等。
      const body = (await res.json().catch(() => null)) as {
        data?: { name?: string; status?: string }[];
      } | null;
      if (!body?.data) return null;
      return body.data
        .filter((d): d is { name: string; status?: string } =>
          typeof d.name === "string" && d.name.length > 0,
        )
        .map((d) => ({ name: d.name, verified: d.status === "verified" }));
    } catch {
      // 提示性功能:任何失敗(逾時/網路)都靜默降級為「無提示」。
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
