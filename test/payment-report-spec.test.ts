import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TRANSFER_REPORT_SPEC,
  checkTransferReport,
  normalizeReportSpec,
  reportFields,
  reportSubject,
  type TransferReportSpec,
} from "../src/ext/payment-kit/report-spec";
import { createManualPaymentProvider, transferReportSpec } from "../src/ext/payment-kit/manual";
import type { CoreServices } from "../src/ext/services";

// payment-kit 1.63.0:人工收款的「回報匯款要填什麼」。預設 = 以前寫死的帳號末五碼(5 位數字);
// 付款方式可以改成別的參考碼(名稱、位數)、匯款人姓名、擇一或兩個都要。

const spec = (ask: TransferReportSpec["ask"], label = "帳號末五碼", digits = 5): TransferReportSpec => ({ ask, reference: { label, digits } });

describe("normalizeReportSpec", () => {
  it("defaults to the last five digits of the account", () => {
    expect(DEFAULT_TRANSFER_REPORT_SPEC).toEqual(spec("reference"));
    expect(normalizeReportSpec(undefined)).toEqual(spec("reference"));
    expect(normalizeReportSpec({ ask: "nonsense", reference: { label: " ", digits: 99 } })).toEqual(spec("reference"));
  });

  it("keeps a custom label and digits (numbers from the settings page may be strings); 0 = free text", () => {
    expect(normalizeReportSpec({ ask: "either", reference: { label: " 轉帳後六碼 ", digits: "6" } })).toEqual(spec("either", "轉帳後六碼", 6));
    expect(normalizeReportSpec({ ask: "reference", reference: { label: "付款參考", digits: 0 } })).toEqual(spec("reference", "付款參考", 0));
    expect(normalizeReportSpec({ ask: "both", reference: { label: "x".repeat(21), digits: 1.5 } })).toEqual(spec("both"));
  });

  it("a cleared or non-numeric digits setting falls back to 5 digits, never to 0 (no format check)", () => {
    for (const digits of [null, undefined, "", "  ", false, true, "abc", "5.0", "-1", -1, 13, "13", Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
      expect(normalizeReportSpec({ ask: "reference", reference: { label: "帳號末五碼", digits } }).reference.digits).toBe(5);
    }
    expect(normalizeReportSpec({ ask: "reference", reference: { label: "帳號末五碼", digits: " 0 " } }).reference.digits).toBe(0);
    expect(normalizeReportSpec({ ask: "reference", reference: { label: "帳號末五碼", digits: "12" } }).reference.digits).toBe(12);
  });
});

describe("reportFields / reportSubject", () => {
  it.each([
    ["reference", { reference: { required: true }, payerName: null }, "帳號末五碼"],
    ["payerName", { reference: null, payerName: { required: true } }, "匯款人姓名"],
    ["either", { reference: { required: false }, payerName: { required: false } }, "帳號末五碼或匯款人姓名"],
    ["both", { reference: { required: true }, payerName: { required: true } }, "帳號末五碼與匯款人姓名"],
  ] as const)("%s", (ask, fields, subject) => {
    expect(reportFields(spec(ask))).toEqual(fields);
    expect(reportSubject(spec(ask))).toBe(subject);
  });
});

describe("checkTransferReport", () => {
  it("default: five digits, the payer name is dropped; the sentences match the old checkout", () => {
    expect(checkTransferReport(spec("reference"), { reference: " 12345 ", payerName: "王小明" })).toEqual({ ok: true, value: { reference: "12345" } });
    expect(checkTransferReport(spec("reference"), { reference: "1234" })).toEqual({ ok: false, error: "帳號末五碼要填 5 位數字。" });
    expect(checkTransferReport(spec("reference"), { reference: "" })).toEqual({ ok: false, error: "請填帳號末五碼。" });
  });

  it("custom label and digits, and free text", () => {
    expect(checkTransferReport(spec("reference", "轉帳後六碼", 6), { reference: "12345" })).toEqual({ ok: false, error: "轉帳後六碼要填 6 位數字。" });
    expect(checkTransferReport(spec("reference", "轉帳後六碼", 6), { reference: "123456" })).toEqual({ ok: true, value: { reference: "123456" } });
    expect(checkTransferReport(spec("reference", "付款參考", 0), { reference: "ATM-0042 王" })).toEqual({ ok: true, value: { reference: "ATM-0042 王" } });
    expect(checkTransferReport(spec("reference", "付款參考", 0), { reference: "x".repeat(41) })).toEqual({ ok: false, error: "付款參考最多 40 字。" });
  });

  it("payer name only, either, both", () => {
    expect(checkTransferReport(spec("payerName"), { reference: "12345", payerName: "王小明" })).toEqual({ ok: true, value: { payerName: "王小明" } });
    expect(checkTransferReport(spec("payerName"), { payerName: "王".repeat(51) })).toEqual({ ok: false, error: "匯款人姓名最多 50 字。" });
    expect(checkTransferReport(spec("either"), { payerName: "王小明" })).toEqual({ ok: true, value: { payerName: "王小明" } });
    expect(checkTransferReport(spec("either"), {})).toEqual({ ok: false, error: "請填帳號末五碼或匯款人姓名。" });
    expect(checkTransferReport(spec("both"), { reference: "12345" })).toEqual({ ok: false, error: "請填匯款人姓名。" });
    expect(checkTransferReport(spec("both"), { payerName: "王小明" })).toEqual({ ok: false, error: "請填帳號末五碼。" });
  });

  it("rejects control characters and line separators inside a payer name or a free-text reference", () => {
    // The report ends up in the order's verify note, one line per entry: a newline would forge another line.
    for (const bad of ["王小明\n核可 by admin", "王\r小明", "王\u0000小明", "王\u007f小明", "王\u0085小明", "王\u2028小明", "王\u2029小明", "王\t小明"]) {
      expect(checkTransferReport(spec("payerName"), { payerName: bad })).toEqual({ ok: false, error: "匯款人姓名有無法使用的字元。" });
      expect(checkTransferReport(spec("reference", "付款參考", 0), { reference: bad })).toEqual({ ok: false, error: "付款參考有無法使用的字元。" });
    }
    expect(checkTransferReport(spec("reference"), { reference: "123\n45" })).toEqual({ ok: false, error: "帳號末五碼有無法使用的字元。" });
    // Surrounding whitespace, a trailing newline included, is trimmed as before.
    expect(checkTransferReport(spec("both"), { reference: "12345\n", payerName: " 王小明\n" })).toEqual({ ok: true, value: { reference: "12345", payerName: "王小明" } });
  });
});

describe("transferReportSpec(provider)", () => {
  const services = {} as CoreServices;
  const make = (reportSpec?: () => Promise<TransferReportSpec>) =>
    createManualPaymentProvider({ services, providerId: "bank", table: "ext_bank_orders", instructions: async () => ({ ok: true, instructions: [] }), reportSpec });

  it("reads the manual provider's spec, normalized", async () => {
    expect(await transferReportSpec(make(async () => spec("both", "轉帳後六碼", 6)))).toEqual(spec("both", "轉帳後六碼", 6));
    expect(await transferReportSpec(make(async () => ({ ask: "nope" }) as unknown as TransferReportSpec))).toEqual(spec("reference"));
  });

  it("default for a provider without one, a gateway, none, or one that fails", async () => {
    expect(await transferReportSpec(make())).toEqual(spec("reference"));
    expect(await transferReportSpec({ createCheckout: async () => ({ ok: false, error: "x" }) })).toEqual(spec("reference"));
    expect(await transferReportSpec(null)).toEqual(spec("reference"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await transferReportSpec(make(async () => { throw new Error("settings down"); }))).toEqual(spec("reference"));
    } finally {
      log.mockRestore();
    }
  });
});
