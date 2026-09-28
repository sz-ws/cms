import { describe, expect, it, vi } from "vitest";
import {
  REPORT_URL,
  explainTransferReportError,
  reportEmailFor,
  reportOnce,
  sendTransferReport,
  transferReportRequest,
} from "../extensions/shop/transfer-report";

// 商店:結帳完成頁回報匯款送到哪裡、伺服器的錯誤怎麼說、同一張訂單只送一次。要填什麼與送出前的
// 檢查在 payment-kit(test/payment-report-spec.test.ts);畫面在 test/shop-transfer-report-view.test.tsx。

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("送到哪裡", () => {
  it("一律商店的 transfer-report;帶了下單 Email 就送,沒帶不送(伺服器看登入的人)", () => {
    expect(transferReportRequest({ orderNo: "SM1" }, { reference: "12345", payerName: "王小明" })).toEqual({
      url: REPORT_URL,
      body: { orderNo: "SM1", reference: "12345", payerName: "王小明" },
    });
    expect(transferReportRequest({ orderNo: "SO1", email: "a@example.com" }, { payerName: "王小明" })).toEqual({
      url: REPORT_URL,
      body: { orderNo: "SO1", payerName: "王小明", email: "a@example.com" },
    });
    expect(REPORT_URL).toBe("/api/ext/shop/transfer-report");
  });

  it("商店自己的訂單一律帶下單 Email(core 用它確認是下單的人);受管訂單只有訪客帶", () => {
    const email = "a@example.com";
    expect(reportEmailFor({ email, managed: false, asGuest: false })).toBe(email);
    expect(reportEmailFor({ email, managed: true, asGuest: true })).toBe(email);
    expect(reportEmailFor({ email, managed: true, asGuest: false })).toBeUndefined();
  });
});

describe("伺服器的錯誤", () => {
  it("有給一句話就用它;認得的代碼換成一句話;中文句子照原句;其餘一句通用的", async () => {
    const request = transferReportRequest({ orderNo: "SO1" }, { reference: "12345" });
    const refused = vi.fn(async () => reply(400, { ok: false, error: "invalid_input", message: "帳號末五碼要填 5 位數字。" }));
    expect(await sendTransferReport(request, refused as unknown as typeof fetch)).toEqual({ ok: false, error: "帳號末五碼要填 5 位數字。" });
    const gone = vi.fn(async () => reply(404, { ok: false, error: "not_found" }));
    expect(await sendTransferReport(request, gone as unknown as typeof fetch)).toEqual({ ok: false, error: "找不到這筆訂單，或它已經不能回報匯款。" });
    expect(explainTransferReportError("此訂單已不能回報匯款")).toBe("此訂單已不能回報匯款");
    expect(explainTransferReportError("unauthorized")).toContain("重新登入");
    expect(explainTransferReportError("server_error")).toBe("回報沒有送出，請再試一次。");
    expect(explainTransferReportError(undefined)).toBe("回報沒有送出，請再試一次。");
  });

  it("送出的內容就是 request;網路錯誤換成一句話", async () => {
    const request = transferReportRequest({ orderNo: "SO1" }, { reference: "12345" });
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => reply(200, { ok: true }));
    expect(await sendTransferReport(request, fetcher as unknown as typeof fetch)).toEqual({ ok: true });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(REPORT_URL);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(request.body);
    const offline = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    expect(await sendTransferReport(request, offline as unknown as typeof fetch)).toEqual({ ok: false, error: "網路錯誤，請重試。" });
  });
});

describe("同一張訂單只記一次", () => {
  it("送出中再按:不再送,拿到同一個結果", async () => {
    let finish: (value: { ok: true }) => void = () => {};
    const send = vi.fn(() => new Promise<{ ok: true }>((resolve) => { finish = resolve; }));
    const submit = reportOnce(send);
    const first = submit({ reference: "12345" });
    const second = submit({ reference: "12345" });
    finish({ ok: true });
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("送成功之後再按:不再送", async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    const submit = reportOnce(send);
    await submit({ reference: "12345" });
    await submit({ reference: "54321" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("失敗之後可以改了再送", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "帳號末五碼要填 5 位數字。" })
      .mockResolvedValueOnce({ ok: true });
    const submit = reportOnce(send);
    expect(await submit({ reference: "1234" })).toEqual({ ok: false, error: "帳號末五碼要填 5 位數字。" });
    expect(await submit({ reference: "12345" })).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ reference: "12345" });
  });

  it("送出時丟錯也不會卡住", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ ok: true });
    const submit = reportOnce(send);
    await expect(submit({ reference: "12345" })).rejects.toThrow("boom");
    expect(await submit({ reference: "12345" })).toEqual({ ok: true });
  });
});
