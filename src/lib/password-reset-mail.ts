import { format, getMessages, type Locale, type MessageKey } from "./i18n";

// 1.56.0:忘記密碼的三封信(內容在 i18n 的 passwordReset.mail.*)。純函式,只組信,不寄。
// 語言跟站台(core.locale),同會員插件的驗證信。

export interface ResetMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function paragraph(text: string, style = "font-size:15px;line-height:1.6"): string {
  return `<p style="${style}">${escapeHtml(text)}</p>`;
}

const SMALL = "font-size:13px;color:#666";

function compose(
  to: string,
  subject: string,
  lines: { lead: string; code?: string; note: string },
  site: string,
): ResetMail {
  const text = [lines.lead, lines.code, lines.note, site].filter(Boolean).join("\n\n");
  const html =
    paragraph(lines.lead) +
    (lines.code
      ? `<p style="font-size:28px;font-weight:600;letter-spacing:4px;margin:16px 0">${lines.code}</p>`
      : "") +
    paragraph(lines.note, SMALL) +
    (site ? paragraph(site, SMALL) : "");
  return { to, subject, text, html };
}

function translator(locale: Locale) {
  const messages = getMessages(locale);
  return (key: MessageKey, params?: Record<string, string | number>) => format(messages[key], params);
}

export function resetCodeMail(to: string, code: string, locale: Locale, site: string): ResetMail {
  const t = translator(locale);
  return compose(
    to,
    t("passwordReset.mail.codeSubject", { code }),
    { lead: t("passwordReset.mail.codeBody"), code, note: t("passwordReset.mail.codeIgnore") },
    site,
  );
}

export function staffResetOffMail(to: string, locale: Locale, site: string): ResetMail {
  const t = translator(locale);
  return compose(
    to,
    t("passwordReset.mail.staffOffSubject"),
    { lead: t("passwordReset.mail.staffOffBody"), note: t("passwordReset.mail.codeIgnore") },
    site,
  );
}

export function passwordChangedMail(to: string, locale: Locale, site: string): ResetMail {
  const t = translator(locale);
  return compose(
    to,
    t("passwordReset.mail.changedSubject"),
    { lead: t("passwordReset.mail.changedBody", { email: to }), note: t("passwordReset.mail.changedNotYou") },
    site,
  );
}
