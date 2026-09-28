import { describe, expect, it, vi } from "vitest";
import {
  GUEST_REPORT_URL,
  MEMBER_REPORT_URL,
  TRANSFER_REPORT_MODES,
  explainTransferReportError,
  readTransferReport,
  reportOnce,
  resolveTransferReport,
  sendTransferReport,
  transferReportFields,
  transferReportRequest,
} from "../extensions/shop/transfer-report";

// 商店 0.8.0:受管訂單在結帳完成頁回報匯款。欄位照受管訂單那一邊的設定、會員與訪客各送到哪裡、
// 同一張訂單只送一次。畫面在 test/shop-transfer-report-view.test.tsx。

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("要填哪幾格", () => {
  it.each([
    ["last5", { last5: { required: true }, name: null }],
    ["name", { last5: null, name: { required: true } }],
    ["either", { last5: { required: false }, name: { required: false } }],
    ["both", { last5: { required: true }, name: { required: true } }],
  ] as const)("%s", (mode, fields) => {
    expect(transferReportFields(mode)).toEqual(fields);
  });

  it("provider 回的值:認得的四種照用,其他一律 null(結局頁照舊請客人到訂單頁回報)", () => {
    for (const mode of TRANSFER_REPORT_MODES) expect(resolveTransferReport(mode)).toBe(mode);
    for (const value of [undefined, null, "", "LAST5", 5, { mode: "last5" }]) expect(resolveTransferReport(value), String(value)).toBeNull();
  });
});

describe("送出前的檢查", () => {
  it("末五碼:要 5 位數字,姓名那格不送", () => {
    expect(readTransferReport("last5", { last5: " 12345 ", name: "王小明" })).toEqual({ ok: true, value: { last5: "12345" } });
    expect(readTransferReport("last5", { last5: "1234" })).toEqual({ ok: false, error: "帳號末五碼要填 5 位數字。" });
    expect(readTransferReport("last5", { last5: "" })).toEqual({ ok: false, error: "請填帳號末五碼。" });
  });

  it("姓名:末五碼那格不送,最多 50 字", () => {
    expect(readTransferReport("name", { last5: "12345", name: "王小明" })).toEqual({ ok: true, value: { name: "王小明" } });
    expect(readTransferReport("name", { name: "   " })).toEqual({ ok: false, error: "請填匯款人姓名。" });
    expect(readTransferReport("name", { name: "王".repeat(51) })).toEqual({ ok: false, error: "匯款人姓名最多 50 字。" });
  });

  it("擇一:填一格就可以,兩格都空才擋", () => {
    expect(readTransferReport("either", { last5: "12345", name: "" })).toEqual({ ok: true, value: { last5: "12345" } });
    expect(readTransferReport("either", { last5: "", name: "王小明" })).toEqual({ ok: true, value: { name: "王小明" } });
    expect(readTransferReport("either", { last5: "", name: "" })).toEqual({ ok: false, error: "請填帳號末五碼或匯款人姓名。" });
  });

  it("兩個都要:少一格就擋", () => {
    expect(readTransferReport("both", { last5: "12345", name: "王小明" })).toEqual({ ok: true, value: { last5: "12345", name: "王小明" } });
    expect(readTransferReport("both", { last5: "12345" })).toEqual({ ok: false, error: "請填匯款人姓名。" });
    expect(readTransferReport("both", { name: "王小明" })).toEqual({ ok: false, error: "請填帳號末五碼。" });
  });
});

describe("會員與訪客各送到哪裡", () => {
  it("已登入的會員:商城營運的 actions,不帶 Email(伺服器看登入的人)", () => {
    expect(transferReportRequest({ orderNo: "SM1" }, { last5: "12345" })).toEqual({ url: MEMBER_REPORT_URL, body: { action: "report", orderNo: "SM1", last5: "12345" } });
    expect(MEMBER_REPORT_URL).toBe("/api/ext/shop-operations/actions");
  });

  it("訪客:商城營運的 guest,帶下單 Email(和訂單查詢同一組憑證)", () => {
    expect(transferReportRequest({ orderNo: "SM1", guestEmail: "a@example.com" }, { name: "王小明" })).toEqual({ url: GUEST_REPORT_URL, body: { action: "report", orderNo: "SM1", email: "a@example.com", name: "王小明" } });
    expect(GUEST_REPORT_URL).toBe("/api/ext/shop-operations/guest");
  });

  it("訪客的 Email 不對:伺服器回 not_found,說去訂單查詢;會員登入過期說重新登入", async () => {
    const guest = transferReportRequest({ orderNo: "SM1", guestEmail: "wrong@example.com" }, { last5: "12345" });
    const fetcher = vi.fn(async () => reply(404, { ok: false, error: "not_found" }));
    expect(await sendTransferReport(guest, fetcher as unknown as typeof fetch)).toEqual({ ok: false, error: explainTransferReportError("not_found") });
    expect(explainTransferReportError("not_found")).toBe("找不到這筆訂單，請到「我的訂單」或「訂單查詢」確認。");
    const member = transferReportRequest({ orderNo: "SM1" }, { last5: "12345" });
    const expired = vi.fn(async () => reply(401, { error: "unauthorized" }));
    expect(await sendTransferReport(member, expired as unknown as typeof fetch)).toEqual({ ok: false, error: explainTransferReportError("unauthorized") });
    expect(explainTransferReportError("unauthorized")).toContain("重新登入");
  });

  it("送出的內容就是 request;伺服器的中文句子照原句,英文代碼與網路錯誤換成一句話", async () => {
    const request = transferReportRequest({ orderNo: "SM1", guestEmail: "a@example.com" }, { last5: "12345" });
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => reply(200, { ok: true, order: {} }));
    expect(await sendTransferReport(request, fetcher as unknown as typeof fetch)).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(GUEST_REPORT_URL);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(request.body);

    const refused = vi.fn(async () => reply(409, { ok: false, error: "此訂單已不能回報匯款" }));
    expect(await sendTransferReport(request, refused as unknown as typeof fetch)).toEqual({ ok: false, error: "此訂單已不能回報匯款" });
    const offline = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    expect(await sendTransferReport(request, offline as unknown as typeof fetch)).toEqual({ ok: false, error: "網路錯誤，請重試。" });
    expect(explainTransferReportError("server_error")).toBe("回報沒有送出，請再試一次。");
    expect(explainTransferReportError(undefined)).toBe("回報沒有送出，請再試一次。");
  });
});

describe("同一張訂單只記一次", () => {
  it("送出中再按:不再送,拿到同一個結果", async () => {
    let finish: (value: { ok: true }) => void = () => {};
    const send = vi.fn(() => new Promise<{ ok: true }>((resolve) => { finish = resolve; }));
    const submit = reportOnce(send);
    const first = submit({ last5: "12345" });
    const second = submit({ last5: "12345" });
    finish({ ok: true });
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("送成功之後再按:不再送", async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    const submit = reportOnce(send);
    await submit({ last5: "12345" });
    await submit({ last5: "54321" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("失敗之後可以改了再送", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "帳號末五碼要填 5 位數字" })
      .mockResolvedValueOnce({ ok: true });
    const submit = reportOnce(send);
    expect(await submit({ last5: "1234" })).toEqual({ ok: false, error: "帳號末五碼要填 5 位數字" });
    expect(await submit({ last5: "12345" })).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ last5: "12345" });
  });

  it("送出時丟錯也不會卡住", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ ok: true });
    const submit = reportOnce(send);
    await expect(submit({ last5: "12345" })).rejects.toThrow("boom");
    expect(await submit({ last5: "12345" })).toEqual({ ok: true });
  });
});
