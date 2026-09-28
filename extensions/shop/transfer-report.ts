// 受管訂單在結帳完成頁回報匯款(shop 0.8.0)。這裡沒有 React:要填哪幾格、送出前的檢查、送到哪裡、
// 伺服器的錯誤怎麼說,測試直接呼叫(test/shop-transfer-report.test.ts)。畫面在 TransferReportForm.tsx。
//
// 要填什麼由受管訂單那一邊決定(`commerce:orders` provider 的 transferReport(),public-pages.tsx 在伺服器
// 讀出來交給 CheckoutView)。送到它現成的兩個端點,和它自己的「我的訂單」、訂單查詢記錄同一份回報:
//   - 已登入的會員:POST /api/ext/shop-operations/actions { action: "report", orderNo, last5?, name? }
//     伺服器看登入的人,只能回報自己名下的訂單。
//   - 訪客:POST /api/ext/shop-operations/guest { action: "report", orderNo, email, last5?, name? }
//     憑證和訂單查詢一樣是訂單編號 + 下單 Email;這一頁剛送出結帳表單,兩樣都在手上,不另外發憑證。

export const TRANSFER_REPORT_MODES = ["last5", "name", "either", "both"] as const;
/** last5 帳號末五碼、name 匯款人姓名、either 擇一、both 兩個都要。 */
export type TransferReportMode = (typeof TRANSFER_REPORT_MODES)[number];

/** provider 回的值 → 模式;不認得的值是 null(結局頁照舊請客人到訂單頁回報)。 */
export function resolveTransferReport(value: unknown): TransferReportMode | null {
  return TRANSFER_REPORT_MODES.find((mode) => mode === value) ?? null;
}

/** 這個模式有哪幾格、哪幾格必填(null = 不出現)。 */
export function transferReportFields(mode: TransferReportMode): {
  last5: { required: boolean } | null;
  name: { required: boolean } | null;
} {
  const required = mode !== "either";
  return {
    last5: mode === "name" ? null : { required },
    name: mode === "last5" ? null : { required },
  };
}

export interface TransferReportValue {
  last5?: string;
  name?: string;
}

/**
 * 客人填的 → 要送的。不出現的那格丟掉、空白算沒填;少填或格式不對回一句話。
 * 規則和受管訂單那一邊相同,伺服器照樣再檢查一次。
 */
export function readTransferReport(
  mode: TransferReportMode,
  raw: { last5?: string; name?: string },
): { ok: true; value: TransferReportValue } | { ok: false; error: string } {
  const fields = transferReportFields(mode);
  const last5 = fields.last5 ? (raw.last5 ?? "").trim() : "";
  const name = fields.name ? (raw.name ?? "").trim() : "";
  if (last5 && !/^\d{5}$/.test(last5)) return { ok: false, error: "帳號末五碼要填 5 位數字。" };
  if (name.length > 50) return { ok: false, error: "匯款人姓名最多 50 字。" };
  if (fields.last5?.required && !last5) return { ok: false, error: "請填帳號末五碼。" };
  if (fields.name?.required && !name) return { ok: false, error: "請填匯款人姓名。" };
  if (!last5 && !name) return { ok: false, error: "請填帳號末五碼或匯款人姓名。" };
  return { ok: true, value: { ...(last5 ? { last5 } : {}), ...(name ? { name } : {}) } };
}

export interface TransferReportOrder {
  orderNo: string;
  /** 訪客:下單時填的 Email(查單的憑證)。已登入的會員不帶,伺服器看登入的人。 */
  guestEmail?: string;
}

export const MEMBER_REPORT_URL = "/api/ext/shop-operations/actions";
export const GUEST_REPORT_URL = "/api/ext/shop-operations/guest";

/** 送到哪裡、送什麼。 */
export function transferReportRequest(
  order: TransferReportOrder,
  value: TransferReportValue,
): { url: string; body: Record<string, unknown> } {
  return order.guestEmail !== undefined
    ? { url: GUEST_REPORT_URL, body: { action: "report", orderNo: order.orderNo, email: order.guestEmail, ...value } }
    : { url: MEMBER_REPORT_URL, body: { action: "report", orderNo: order.orderNo, ...value } };
}

const ERRORS: Record<string, string> = {
  unauthorized: "請重新登入後，再到「我的訂單」回報。",
  not_found: "找不到這筆訂單，請到「我的訂單」或「訂單查詢」確認。",
  invalid_input: "請檢查填寫的內容。",
  rate_limited: "嘗試次數過多，請稍後再試。",
};

/** 伺服器的錯誤:認得的代碼換成一句話;中文句子(例如「此訂單已不能回報匯款」)照原句。 */
export function explainTransferReportError(code: unknown): string {
  if (typeof code !== "string" || !code) return "回報沒有送出，請再試一次。";
  return ERRORS[code] ?? (/[^\u0000-\u007f]/.test(code) ? code : "回報沒有送出，請再試一次。");
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
    const data = (await res.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
    if (res.ok && data?.ok === true) return { ok: true };
    return { ok: false, error: explainTransferReportError(data?.error) };
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
