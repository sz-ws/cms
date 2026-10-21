import { isSitePath } from "../site-path";

// 金流把客人送回來(ReturnURL)、又沒有插件認得這筆訂單(PaymentReturn,return-page.ts)時,kit 自己回的那一頁
// (1.79.0)。純靜態 HTML、沒有外部資源:上面是店名與標誌(core.siteTitle、core.brandLogo),中間是結果與這筆
// 付款的摘要,下面是回網站的按鈕。白底,顏色只在結果的圖示上。

export type ResultOutcome = "paid" | "failed" | "unknown";

export interface ResultPageInput {
  outcome: ResultOutcome;
  /** core.siteUrl(去掉結尾的 /);空字串 = 沒設定,不畫回網站的按鈕。 */
  siteUrl: string;
  siteName: string;
  /** core.brandLogo:https 網址或站內路徑;其他的不畫。 */
  logoUrl: string;
  orderNo?: string;
  /** 已照幣別寫好的金額,例如「NT$ 1,050」。 */
  amount?: string;
  paymentType?: string;
  tradeNo?: string;
  payTime?: string;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const COPY: Record<ResultOutcome, { title: string; lead: string }> = {
  paid: { title: "付款完成", lead: "我們已收到您的款項，謝謝您！" },
  failed: { title: "付款未完成", lead: "交易未成功，未收取任何款項。可以回到網站再試一次。" },
  unknown: { title: "付款結果確認中", lead: "還沒收到這筆付款的結果，請先不要重新付款。稍後查看訂單，或聯絡店家確認。" },
};

const ICON: Record<ResultOutcome, string> = {
  paid: '<path d="M5 12.5l4.5 4.5L19 7.5" />',
  failed: '<path d="M7 7l10 10M17 7L7 17" />',
  unknown: '<path d="M12 7v6M12 16.5v.5" />',
};

/** 信用卡以外的代碼原樣不顯示(看不懂的代碼不給客人看)。 */
const PAYMENT_TYPES: Record<string, string> = {
  CREDIT: "信用卡",
  WEBATM: "網路 ATM",
  VACC: "ATM 轉帳",
  CVS: "超商代碼",
  BARCODE: "超商條碼",
  APPLEPAY: "Apple Pay",
  GOOGLEPAY: "Google Pay",
  LINEPAY: "LINE Pay",
};

/** 標誌網址:https 或站內路徑(站內路徑接在 siteUrl 後面);其他(http、javascript: …)是 null。 */
function logoSource(logoUrl: string, siteUrl: string): string | null {
  const url = logoUrl.trim();
  if (!url) return null;
  if (isSitePath(url)) return siteUrl ? `${siteUrl}${url}` : url;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function renderResultPage(input: ResultPageInput): string {
  const copy = COPY[input.outcome];
  const name = input.siteName.trim();
  const logo = logoSource(input.logoUrl, input.siteUrl);
  const rows: [string, string][] = [];
  if (input.outcome !== "unknown") {
    if (input.orderNo) rows.push(["訂單編號", input.orderNo]);
    if (input.amount) rows.push(["金額", input.amount]);
    const type = input.paymentType ? PAYMENT_TYPES[input.paymentType.toUpperCase()] : undefined;
    if (type) rows.push(["付款方式", type]);
    if (input.outcome === "paid" && input.tradeNo) rows.push(["交易序號", input.tradeNo]);
    if (input.outcome === "paid" && input.payTime) rows.push(["付款時間", input.payTime]);
  }
  const brand = name || logo
    ? `<header class="brand">${logo ? `<img src="${escapeHtml(logo)}" alt="" />` : ""}${name ? `<span>${escapeHtml(name)}</span>` : ""}</header>`
    : "";
  const summary = rows.length > 0
    ? `<dl class="summary">${rows.map(([k, v]) => `<div class="row"><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}</dl>`
    : "";
  const actions = input.siteUrl ? `<a class="btn primary" href="${escapeHtml(input.siteUrl)}">返回網站</a>` : "";
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${copy.title}${name ? `｜${escapeHtml(name)}` : ""}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         padding: 32px 16px; background: #fff; color: #1d1d1f;
         font-family: -apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif;
         -webkit-font-smoothing: antialiased; }
  main { width: 100%; max-width: 400px; text-align: center; }
  .brand { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 40px;
           font-size: 15px; font-weight: 600; color: rgba(0,0,0,.72); }
  .brand img { height: 32px; width: auto; max-width: 140px; object-fit: contain; }
  .icon { width: 72px; height: 72px; margin: 0 auto 20px; border-radius: 50%; display: grid; place-items: center; }
  .icon svg { width: 34px; height: 34px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
  .paid .icon { background: #e7f6ec; color: #1a7f37; }
  .failed .icon { background: #fdeceb; color: #c4291c; }
  .unknown .icon { background: #fdf3e1; color: #a86200; }
  h1 { margin: 0 0 10px; font-size: 24px; font-weight: 700; letter-spacing: -0.01em; }
  .lead { margin: 0; font-size: 15px; line-height: 1.65; color: rgba(0,0,0,.6); }
  .summary { margin: 28px 0 0; padding: 18px 20px; border-radius: 16px; background: #f6f6f5; display: grid; gap: 12px; text-align: left; }
  .row { display: flex; justify-content: space-between; gap: 16px; font-size: 14px; line-height: 1.4; }
  .row dt { color: rgba(0,0,0,.5); flex-shrink: 0; }
  .row dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; overflow-wrap: anywhere; }
  .actions { margin-top: 28px; display: grid; gap: 10px; }
  .btn { display: block; padding: 15px 16px; border-radius: 14px; font-size: 15px; font-weight: 600; text-decoration: none; }
  .primary { background: #1d1d1f; color: #fff; }
</style>
</head>
<body>
<main class="${input.outcome}">
  ${brand}
  <div class="icon"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[input.outcome]}</svg></div>
  <h1>${copy.title}</h1>
  <p class="lead">${copy.lead}</p>
  ${summary}
  ${actions ? `<div class="actions">${actions}</div>` : ""}
</main>
</body>
</html>`;
}
