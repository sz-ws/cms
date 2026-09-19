import { describe, it, expect, beforeEach, vi } from "vitest";

// 1.44.0:CloudflareEmailProvider(send_email 綁定)。settings 與 env 都替身。

const state = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  env: {} as Record<string, unknown>,
}));
vi.mock("@/lib/settings", () => ({
  getSetting: async (key: string, fallback?: unknown) => state.settings[key] ?? fallback,
}));
vi.mock("@/lib/cf", () => ({ getEnv: () => state.env }));

import { CloudflareEmailProvider, parseFromAddress } from "../src/ext/providers/email-cloudflare";

const MSG = { to: "a@example.com", subject: "Hello", text: "hi" };

describe("CloudflareEmailProvider", () => {
  const provider = new CloudflareEmailProvider();
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    send = vi.fn(async () => ({ messageId: "msg_1" }));
    state.env = { EMAIL: { send } };
    state.settings = { "core.emailFrom": "Acme <noreply@acme.test>" };
  });

  it("不完整的訊息不呼叫綁定", async () => {
    expect(await provider.send({ ...MSG, to: [] })).toEqual({ ok: false, error: "invalid_message" });
    expect(await provider.send({ to: "a@example.com", subject: "Hi" })).toEqual({ ok: false, error: "invalid_message" });
    expect(send).not.toHaveBeenCalled();
  });

  it("沒有 EMAIL 綁定或寄件地址 → not_configured", async () => {
    state.env = {};
    expect(await provider.send(MSG)).toEqual({ ok: false, error: "not_configured" });
    state.env = { EMAIL: { send } };
    state.settings = {};
    expect(await provider.send(MSG)).toEqual({ ok: false, error: "not_configured" });
    expect(send).not.toHaveBeenCalled();
  });

  it("寄出:收件人轉成陣列,寄件人拆成名稱與地址,回傳 messageId", async () => {
    const result = await provider.send({ ...MSG, html: "<p>hi</p>", replyTo: "help@acme.test" });
    expect(result).toEqual({ ok: true, id: "msg_1" });
    expect(send).toHaveBeenCalledWith({
      to: ["a@example.com"],
      from: { email: "noreply@acme.test", name: "Acme" },
      subject: "Hello",
      html: "<p>hi</p>",
      text: "hi",
      replyTo: "help@acme.test",
    });
  });

  it("綁定丟出帶 code 的錯誤 → provider_error,code 放進 detail", async () => {
    send.mockRejectedValueOnce(Object.assign(new Error("domain not verified"), { code: "E_SENDER_NOT_VERIFIED" }));
    expect(await provider.send(MSG)).toEqual({
      ok: false,
      error: "provider_error",
      detail: "cloudflare E_SENDER_NOT_VERIFIED: domain not verified",
    });
  });
});

describe("parseFromAddress", () => {
  it("拆出顯示名稱;純地址原樣", () => {
    expect(parseFromAddress("Acme <noreply@acme.test>")).toEqual({ email: "noreply@acme.test", name: "Acme" });
    expect(parseFromAddress('"Acme Shop" <noreply@acme.test>')).toEqual({ email: "noreply@acme.test", name: "Acme Shop" });
    expect(parseFromAddress("<noreply@acme.test>")).toBe("noreply@acme.test");
    expect(parseFromAddress(" noreply@acme.test ")).toBe("noreply@acme.test");
  });
});
