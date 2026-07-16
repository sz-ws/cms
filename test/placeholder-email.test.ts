import { describe, it, expect, beforeEach, vi } from "vitest";

// spec-login-providers.md §2(追加):isPlaceholderEmail helper + email 寄送路徑
// 遇 placeholder 直接 skip 的行為。

import { isPlaceholderEmail, PLACEHOLDER_EMAIL_SUFFIX } from "../src/lib/auth";

describe("isPlaceholderEmail", () => {
  it("matches synthesized placeholder addresses (case-insensitive)", () => {
    expect(isPlaceholderEmail("oauth-line-login-ab12cd34@placeholder.invalid")).toBe(true);
    expect(isPlaceholderEmail("OAUTH-GOOGLE-DEADBEEF@PLACEHOLDER.INVALID")).toBe(true);
    expect(PLACEHOLDER_EMAIL_SUFFIX).toBe("@placeholder.invalid");
  });

  it("does not match real addresses", () => {
    expect(isPlaceholderEmail("real@example.com")).toBe(false);
    expect(isPlaceholderEmail("x@placeholder.invalid.example.com")).toBe(false);
    expect(isPlaceholderEmail("")).toBe(false);
  });
});

// sendEmail 的 provider mock:記錄是否被呼叫、以何 recipient。
const providerSend = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, id: "mock-id" })));
vi.mock("@/ext/loader", () => ({ getExtRuntime: async () => ({}) }));
vi.mock("@/ext/services", () => ({
  buildProviderRegistry: () => ({
    resolveActive: async () => {},
    get: () => ({ send: providerSend }),
  }),
}));

import { sendEmail } from "../src/lib/email";

describe("sendEmail — placeholder recipients are skipped", () => {
  beforeEach(() => {
    providerSend.mockClear();
  });

  it("skips entirely when the only recipient is a placeholder (provider not called)", async () => {
    const result = await sendEmail({
      to: "oauth-line-login-ab12cd34@placeholder.invalid",
      subject: "hi",
      text: "body",
    });
    expect(providerSend).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("sends to a real recipient", async () => {
    await sendEmail({ to: "real@example.com", subject: "hi", text: "body" });
    expect(providerSend).toHaveBeenCalledTimes(1);
    const msg = providerSend.mock.calls[0][0] as { to: string | string[] };
    expect(msg.to).toBe("real@example.com");
  });

  it("filters placeholders out of an array recipient list", async () => {
    await sendEmail({
      to: ["real@example.com", "oauth-x@placeholder.invalid"],
      subject: "hi",
      text: "body",
    });
    expect(providerSend).toHaveBeenCalledTimes(1);
    const msg = providerSend.mock.calls[0][0] as { to: string | string[] };
    expect(msg.to).toBe("real@example.com");
  });

  it("skips when every array recipient is a placeholder", async () => {
    const result = await sendEmail({
      to: ["a@placeholder.invalid", "b@placeholder.invalid"],
      subject: "hi",
      text: "body",
    });
    expect(providerSend).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });
});
