import { describe, it, expect } from "vitest";
import { applyEmailDomain } from "../src/lib/email-from";

// applyEmailDomain:EmailDomainChips 點擊網域時的值改寫(保留 local part 與
// "Name <…>" 包裝;空值/純顯示名稱補 noreply)。

describe("applyEmailDomain", () => {
  it("replaces the domain inside a Name <local@domain> wrapper", () => {
    expect(applyEmailDomain("Suko <noreply@old.tw>", "mail.suko.tw")).toBe(
      "Suko <noreply@mail.suko.tw>",
    );
  });

  it("replaces the domain of a bare address", () => {
    expect(applyEmailDomain("hello@old.tw", "mail.suko.tw")).toBe(
      "hello@mail.suko.tw",
    );
    // @ 後還沒打完也能換
    expect(applyEmailDomain("hello@", "mail.suko.tw")).toBe(
      "hello@mail.suko.tw",
    );
  });

  it("fills noreply@ for an empty value", () => {
    expect(applyEmailDomain("", "mail.suko.tw")).toBe("noreply@mail.suko.tw");
    expect(applyEmailDomain("   ", "mail.suko.tw")).toBe(
      "noreply@mail.suko.tw",
    );
  });

  it("wraps a display-name-only value", () => {
    expect(applyEmailDomain("Suko", "mail.suko.tw")).toBe(
      "Suko <noreply@mail.suko.tw>",
    );
  });
});
