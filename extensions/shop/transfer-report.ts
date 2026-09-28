import type { TransferReportValue } from "@/ext/payment-kit/report-spec";

// 結帳完成頁回報匯款(shop 0.8.0 起;0.9.0 要填什麼照收款方式的 reportSpec)。這裡沒有 React:送到哪裡、
// 伺服器的錯誤怎麼說、只送一次,測試直接呼叫(test/shop-transfer-report.test.ts)。要填哪幾格與送出前的
// 檢查是 payment-kit 的 report-spec.ts(伺服器用同一份);畫面在 TransferReportForm.tsx。
//
// 送到哪裡:一律 POST /api/ext/shop/transfer-report { orderNo, reference?, payerName?, email? }。
// email 是下單的 Email,證明回報的是下單的人:商店自己的訂單一律帶(core 1.63.0 起沒帶、又不是登入的本人或
// 管理員就不收);訂單管理插件的訂單由 core 轉給它(OrderManager.reportTransfer),會員看登入的人、訪客帶 Email。

export type { TransferReportValue };

export interface TransferReportOrder {
  orderNo: string;
  /**
   * 下單時填的 Email,和回報一起送:商店自己的訂單、訪客下的受管訂單都帶。已登入會員的受管訂單不帶
   * (帶了,接手的插件會把它當訪客的訂單查),伺服器看登入的人。
   */
  email?: string;
}

export const REPORT_URL = "/api/ext/shop/transfer-report";

/** 結帳完成頁的回報帶不帶下單 Email:商店自己的訂單與訪客下的受管訂單帶;已登入會員的受管訂單不帶。 */
export function reportEmailFor(order: { email: string; managed: boolean; asGuest: boolean }): string | undefined {
  return order.asGuest || !order.managed ? order.email : undefined;
}

/** 送到哪裡、送什麼。 */
export function transferReportRequest(
  order: TransferReportOrder,
  value: TransferReportValue,
): { url: string; body: Record<string, unknown> } {
  return {
    url: REPORT_URL,
    body: {
      orderNo: order.orderNo,
      ...value,
      ...(order.email !== undefined ? { email: order.email } : {}),
    },
  };
}

const ERRORS: Record<string, string> = {
  unauthorized: "請重新登入後再回報。",
  not_found: "找不到這筆訂單，或它已經不能回報匯款。",
  invalid_input: "請檢查填寫的內容。",
  rate_limited: "嘗試次數過多，請稍後再試。",
};

const FALLBACK = "回報沒有送出，請再試一次。";

/**
 * 伺服器的錯誤:有給一句話(message)就用它;認得的代碼換成一句話;中文句子(例如「此訂單已不能回報
 * 匯款」)照原句。
 */
export function explainTransferReportError(code: unknown, message?: unknown): string {
  if (typeof message === "string" && message.trim()) return message.trim();
  if (typeof code !== "string" || !code) return FALLBACK;
  return ERRORS[code] ?? (/[^\u0000-\u007f]/.test(code) ? code : FALLBACK);
}

export type TransferReportResult = { ok: true } | { ok: false; error: string };

/** 送出一次回報。 */
export async function sendTransferReport(
  request: { url: string; body: Record<string, unknown> },
  fetcher: typeof fetch = fetch,
): Promise<TransferReportResult> {
  try {
    const res = await fetcher(request.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.body),
      cache: "no-store",
    });
    const data = (await res.json().catch(() => null)) as
      | { ok?: unknown; error?: unknown; message?: unknown }
      | null;
    if (res.ok && data?.ok === true) return { ok: true };
    return { ok: false, error: explainTransferReportError(data?.error, data?.message) };
  } catch {
    return { ok: false, error: "網路錯誤，請重試。" };
  }
}

/**
 * 同一張訂單只記一次:送出中再按、送成功之後再按,都拿到同一個結果,不會再送。
 * 失敗之後可以改了再送。
 */
export function reportOnce(
  send: (value: TransferReportValue) => Promise<TransferReportResult>,
): (value: TransferReportValue) => Promise<TransferReportResult> {
  let current: Promise<TransferReportResult> | null = null;
  return (value) => {
    if (current) return current;
    const attempt = send(value).then(
      (result) => {
        if (!result.ok) current = null;
        return result;
      },
      (error: unknown) => {
        current = null;
        throw error;
      },
    );
    current = attempt;
    return attempt;
  };
}
