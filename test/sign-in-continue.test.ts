import { describe, expect, it } from "vitest";
import { continueUrl, signedInDestination } from "../src/lib/sign-in-continue";

// 1.55.0:統一登入入口的分流(lib/sign-in-continue.ts)。

describe("signedInDestination", () => {
  it("sends staff to next, or to the admin", () => {
    expect(signedInDestination(true, "/admin/ext/shop", "/member/sign-in")).toBe("/admin/ext/shop");
    expect(signedInDestination(true, "/shop/checkout", "/member/sign-in")).toBe("/shop/checkout");
    expect(signedInDestination(true, null, "/member/sign-in")).toBe("/admin");
  });

  it("never sends a member into the admin, the admin sign-in or the API", () => {
    for (const next of ["/admin", "/admin/account", "/login", "/setup", "/api/users", "/ADMIN/x"]) {
      expect(signedInDestination(false, next, "/member/sign-in")).toBe("/member/sign-in");
    }
  });

  it("sends a member to next, else back to the sign-in page, else home", () => {
    expect(signedInDestination(false, "/shop/orders", "/member/sign-in")).toBe("/shop/orders");
    expect(signedInDestination(false, null, "/member/sign-in?x=1")).toBe("/member/sign-in?x=1");
    expect(signedInDestination(false, null, null)).toBe("/");
  });

  it("ignores off-site targets", () => {
    for (const bad of ["//evil.test", "https://evil.test", "/\\evil.test", "/a\tb"]) {
      expect(signedInDestination(true, bad, null)).toBe("/admin");
      expect(signedInDestination(false, bad, bad)).toBe("/");
    }
  });
});

describe("continueUrl", () => {
  it("carries only site paths", () => {
    expect(continueUrl("/admin", "/member/sign-in")).toBe("/api/auth/continue?next=%2Fadmin&stay=%2Fmember%2Fsign-in");
    expect(continueUrl("//evil.test", null)).toBe("/api/auth/continue");
  });
});
