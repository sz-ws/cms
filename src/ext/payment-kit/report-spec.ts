// payment-kit 1.63.0:人工收款的「回報匯款要填什麼」。純函式、沒有 server 相依 —— 結帳頁(client)、
// 回報 API 與接管訂單的插件用同一份規則檢查,錯誤訊息也是同一句。
//
// 付款人匯完款回報一段參考資料,店家拿去對銀行的入帳紀錄。填什麼由收款的 manual provider 決定
// (ManualPaymentProvider.reportSpec();banktransfer 讓店家在設定頁選),沒說就是 DEFAULT:
// 帳號末五碼,5 位數字 —— 1.63.0 以前寫死的規則。
//
//   ask        reference 只填參考碼、payerName 只填匯款人姓名、either 擇一、both 兩個都要。
//   reference  參考碼的名稱(給客人看的欄位名)與位數;digits 0 = 不限格式,最多 40 字。

export const TRANSFER_REPORT_ASKS = ["reference", "payerName", "either", "both"] as const;
export type TransferReportAsk = (typeof TRANSFER_REPORT_ASKS)[number];

export interface TransferReportSpec {
  ask: TransferReportAsk;
  reference: { label: string; digits: number };
}

/** 參考碼最多幾位數字;名稱最多幾個字;不限格式時最多幾個字;匯款人姓名最多幾個字。 */
export const REPORT_LIMITS = Object.freeze({ digits: 12, label: 20, freeText: 40, payerName: 50 });

export const DEFAULT_TRANSFER_REPORT_SPEC: TransferReportSpec = Object.freeze({
  ask: "reference" as const,
  reference: Object.freeze({ label: "帳號末五碼", digits: 5 }),
});

function isAsk(value: unknown): value is TransferReportAsk {
  return TRANSFER_REPORT_ASKS.some((ask) => ask === value);
}

/**
 * 位數:整數,或只有數字的字串(設定頁存的),0 到 REPORT_LIMITS.digits。其他(null、""、false、小數)
 * 是 null —— 清空「參考碼位數」要回到預設的 5 位,不能變成 0(= 不檢查格式)。
 */
function readDigits(raw: unknown): number | null {
  const value = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= REPORT_LIMITS.digits
    ? value
    : null;
}

/** 任何值 → 合法的 spec;壞掉或缺的部分用預設(不擋回報)。數字可以是字串(設定頁存的)。 */
export function normalizeReportSpec(raw: unknown): TransferReportSpec {
  const input = raw !== null && typeof raw === "object" ? (raw as Partial<TransferReportSpec>) : {};
  const reference: Partial<TransferReportSpec["reference"]> = input.reference ?? {};
  const label = typeof reference.label === "string" ? reference.label.trim() : "";
  const fallback = DEFAULT_TRANSFER_REPORT_SPEC.reference;
  return {
    ask: isAsk(input.ask) ? input.ask : DEFAULT_TRANSFER_REPORT_SPEC.ask,
    reference: {
      label: label && label.length <= REPORT_LIMITS.label ? label : fallback.label,
      digits: readDigits(reference.digits) ?? fallback.digits,
    },
  };
}

/** 這個 spec 有哪幾格、哪幾格必填(null = 不出現)。 */
export function reportFields(spec: TransferReportSpec): {
  reference: { required: boolean } | null;
  payerName: { required: boolean } | null;
} {
  const required = spec.ask !== "either";
  return {
    reference: spec.ask === "payerName" ? null : { required },
    payerName: spec.ask === "reference" ? null : { required },
  };
}

/** 對帳時要看的東西(店家的說明文字用):「帳號末五碼」、「匯款人姓名」、「帳號末五碼或匯款人姓名」。 */
export function reportSubject(spec: TransferReportSpec): string {
  const { label } = spec.reference;
  if (spec.ask === "reference") return label;
  if (spec.ask === "payerName") return "匯款人姓名";
  return `${label}${spec.ask === "either" ? "或" : "與"}匯款人姓名`;
}

export interface TransferReportValue {
  reference?: string;
  payerName?: string;
}

export type TransferReportCheck = { ok: true; value: TransferReportValue } | { ok: false; error: string };

/**
 * 控制字元與換行(C0、DEL、C1、U+2028/2029)。回報的內容會寫進核帳紀錄(訂單的 note,一行一筆),
 * 夾帶換行就能在紀錄裡偽造出另一行。trim 之後還在中間的一律擋下。
 */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function referenceProblem(spec: TransferReportSpec, reference: string): string | null {
  const { label, digits } = spec.reference;
  if (CONTROL_RE.test(reference)) return `${label}有無法使用的字元。`;
  if (digits > 0) return new RegExp(`^\\d{${digits}}$`).test(reference) ? null : `${label}要填 ${digits} 位數字。`;
  return reference.length <= REPORT_LIMITS.freeText ? null : `${label}最多 ${REPORT_LIMITS.freeText} 字。`;
}

/**
 * 客人填的 → 要存的。spec 沒有的那格丟掉、空白算沒填;少填或格式不對回一句話。
 * 結帳頁送出前檢查一次,伺服器照同一份規則再檢查一次。
 */
export function checkTransferReport(
  spec: TransferReportSpec,
  raw: { reference?: string | null; payerName?: string | null },
): TransferReportCheck {
  const fields = reportFields(spec);
  const reference = fields.reference ? (raw.reference ?? "").trim() : "";
  const payerName = fields.payerName ? (raw.payerName ?? "").trim() : "";
  const { label } = spec.reference;
  const problem = reference ? referenceProblem(spec, reference) : null;
  if (problem) return { ok: false, error: problem };
  if (CONTROL_RE.test(payerName)) return { ok: false, error: "匯款人姓名有無法使用的字元。" };
  if (payerName.length > REPORT_LIMITS.payerName) {
    return { ok: false, error: `匯款人姓名最多 ${REPORT_LIMITS.payerName} 字。` };
  }
  if (fields.reference?.required && !reference) return { ok: false, error: `請填${label}。` };
  if (fields.payerName?.required && !payerName) return { ok: false, error: "請填匯款人姓名。" };
  if (!reference && !payerName) return { ok: false, error: `請填${label}或匯款人姓名。` };
  return { ok: true, value: { ...(reference ? { reference } : {}), ...(payerName ? { payerName } : {}) } };
}
