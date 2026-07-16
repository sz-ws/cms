import { getExtRuntime } from "@/ext/loader";
import { buildProviderRegistry } from "@/ext/services";
import { isPlaceholderEmail } from "@/lib/auth";
import type {
  EmailDomain,
  EmailMessage,
  EmailProvider,
  EmailSendResult,
} from "@/ext/providers/email";

// core 呼叫端的寄信入口(extension 端走 ctx.services.providers.get<EmailProvider>
// ("email:send"),不經此檔)。跟 services.ts 一樣每次建 registry(含 extension
// provides)+ resolveActive,讓 core.provider.email:send 的切換(未來 SMTP
// extension,可由 code extension 之 provides 貢獻)在這裡也生效。

async function activeEmailProvider(): Promise<EmailProvider> {
  const rt = await getExtRuntime();
  const registry = buildProviderRegistry(rt);
  await registry.resolveActive();
  return registry.get<EmailProvider>("email:send");
}

export async function sendEmail(msg: EmailMessage): Promise<EmailSendResult> {
  // spec-login-providers.md §2:placeholder email(`@placeholder.invalid`,OAuth-only
  // 且拿不到 provider email 的 user)不可寄達 —— 從收件人過濾掉,絕不嘗試寄送。
  // 全部收件人皆 placeholder ⇒ 整封跳過(不呼叫 provider),回 { ok:true, id:null }
  // 的良性 no-op(非錯誤:呼叫端不會誤記 send failed)。
  const recipients = Array.isArray(msg.to) ? msg.to : [msg.to];
  const deliverable = recipients.filter((addr) => !isPlaceholderEmail(addr));
  if (deliverable.length === 0) {
    return { ok: true, id: null };
  }
  const filteredMsg: EmailMessage =
    deliverable.length === recipients.length
      ? msg
      : { ...msg, to: deliverable.length === 1 ? deliverable[0] : deliverable };
  return (await activeEmailProvider()).send(filteredMsg);
}

/**
 * active provider 帳號下的寄信網域(settings 的 from-address 後綴提示)。
 * provider 不支援 listDomains / 未設定 / 查詢失敗 → null(提示性,永不 throw 到 UI)。
 */
export async function listEmailDomains(): Promise<EmailDomain[] | null> {
  const provider = await activeEmailProvider();
  if (!provider.listDomains) return null;
  return provider.listDomains();
}
