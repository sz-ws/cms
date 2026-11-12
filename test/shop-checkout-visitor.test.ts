import { beforeEach, describe, expect, it, vi } from "vitest";

// 2.0:/shop/checkout 是存起來的公開頁,同一份 HTML 給每個訪客,伺服器渲染時不能讀 session。
// 「是不是登入了、要帶入哪個姓名與 Email」改由瀏覽器在頁面出現之後問 GET /api/ext/shop/checkout-visitor。

const session = vi.hoisted(() => ({ user: null as null | { email: string; name: string } }));
vi.mock("@/lib/auth", () => ({ getSessionUser: async () => session.user }));

import { checkoutVisitorHandler } from "../extensions/shop/checkout-visitor";
import { prefillFromVisitor } from "../extensions/shop/checkout-options";

const call = () => checkoutVisitorHandler();

beforeEach(() => {
  session.user = null;
});

describe("GET checkout-visitor", () => {
  it("answers signed-out visitors with nothing to prefill, never cached", async () => {
    const res = await call();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ signedIn: false, contact: {} });
  });

  it("gives a signed-in member their name and email, the same way the page used to", async () => {
    session.user = { email: "ming@example.com", name: "王小明" };
    expect(await (await call()).json()).toEqual({ signedIn: true, contact: { email: "ming@example.com", name: "王小明" } });
  });
});

describe("prefillFromVisitor", () => {
  const empty = { name: "", email: "", phone: "", address: "", region: "" };
  const member = { name: "王小明", email: "ming@example.com", phone: "0912-345-678", address: "某市某路 1 號", region: "北部" };
  it("fills empty fields and never overwrites what the buyer already typed", () => {
    expect(prefillFromVisitor(empty, member, ["北部"])).toEqual(member);
    expect(prefillFromVisitor({ ...empty, name: "自己打的", phone: "02-1234" }, member, ["北部"])).toEqual({ ...member, name: "自己打的", phone: "02-1234" });
    expect(prefillFromVisitor(empty, {}, ["北部"])).toEqual(empty);
  });

  it("takes a saved region only while the shipping settings still list it", () => {
    expect(prefillFromVisitor(empty, member, ["南部"]).region).toBe("");
    expect(prefillFromVisitor(empty, member, []).region).toBe("");
  });
});

