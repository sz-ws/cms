import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ResendEmailProvider 單元測試:settings 與 fetch 都替身,驗證訊息驗證、
// 設定缺失分支、payload 形狀(to 正規化 / reply_to)、Resend 錯誤與網路錯誤。

const settingsState = vi.hoisted(() => ({
  values: {} as Record<string, string>,
}));
vi.mock("@/lib/settings", () => ({
  getSetting: async (key: string, fallback?: unknown) =>
    settingsState.values[key] ?? fallback,
}));

import { ResendEmailProvider } from "../src/ext/providers/email";

const MSG = {
  to: "a@example.com",
  subject: "Hello",
  text: "hi",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ResendEmailProvider", () => {
  const provider = new ResendEmailProvider();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    settingsState.values = {
      "core.resendApiKey": "re_test_key",
      "core.emailFrom": "Suko <noreply@suko.tw>",
    };
    fetchMock = vi.fn(async () => jsonResponse(200, { id: "email_123" }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects invalid messages without calling the API", async () => {
    for (const msg of [
      { ...MSG, to: [] },
      { ...MSG, to: "  " },
      { ...MSG, subject: " " },
      { to: "a@example.com", subject: "Hello" }, // html/text 皆缺
    ]) {
      const res = await provider.send(msg as typeof MSG);
      expect(res).toEqual({ ok: false, error: "invalid_message" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("not_configured when the API key or from address is missing", async () => {
    settingsState.values = { "core.emailFrom": "x <x@x.tw>" };
    expect(await provider.send(MSG)).toEqual({
      ok: false,
      error: "not_configured",
    });

    settingsState.values = { "core.resendApiKey": "re_test_key" };
    expect(await provider.send(MSG)).toEqual({
      ok: false,
      error: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends via Resend with normalized recipients and returns the id", async () => {
    const res = await provider.send({
      ...MSG,
      to: ["a@example.com", "b@example.com"],
      html: "<p>hi</p>",
      replyTo: "reply@suko.tw",
    });
    expect(res).toEqual({ ok: true, id: "email_123" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer re_test_key",
    );
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      from: "Suko <noreply@suko.tw>",
      to: ["a@example.com", "b@example.com"],
      subject: "Hello",
      text: "hi",
      html: "<p>hi</p>",
      reply_to: "reply@suko.tw",
    });
  });

  it("msg.from overrides the core.emailFrom setting", async () => {
    await provider.send({ ...MSG, from: "Other <o@other.tw>" });
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.from).toBe("Other <o@other.tw>");
  });

  it("surfaces Resend API errors as provider_error with detail", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, { name: "validation_error", message: "Invalid `to`" }),
    );
    const res = await provider.send(MSG);
    expect(res).toEqual({
      ok: false,
      error: "provider_error",
      detail: "resend 422: Invalid `to`",
    });
  });

  it("maps network failures to provider_error/network_error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const res = await provider.send(MSG);
    expect(res).toEqual({
      ok: false,
      error: "provider_error",
      detail: "network_error",
    });
  });

  // ---- listDomains(from-address 後綴提示;提示性,一律失敗即 null)----

  it("listDomains returns null without an API key and never fetches", async () => {
    settingsState.values = {};
    expect(await provider.listDomains()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("listDomains maps Resend domains and verified status", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          { name: "mail.suko.tw", status: "verified" },
          { name: "news.suko.tw", status: "pending" },
          { status: "verified" }, // name 缺失 → 略過
        ],
      }),
    );
    expect(await provider.listDomains()).toEqual([
      { name: "mail.suko.tw", verified: true },
      { name: "news.suko.tw", verified: false },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/domains");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer re_test_key",
    );
  });

  it("listDomains degrades to null on provider errors and bad bodies", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: "nope" }));
    expect(await provider.listDomains()).toBeNull();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { unexpected: true }));
    expect(await provider.listDomains()).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    expect(await provider.listDomains()).toBeNull();
  });
});
