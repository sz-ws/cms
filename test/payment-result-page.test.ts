import { describe, it, expect } from "vitest";
import { renderResultPage } from "../src/ext/payment-kit/result-page";
import { isTestOrderNo, TEST_ORDER_PREFIX } from "../src/ext/payment-kit/checkout-route";

// 1.79.0:沒有插件認得這筆訂單時,kit 自己回的付款結果頁。

const base = { siteUrl: "https://shop.example", siteName: "測試商店", logoUrl: "https://shop.example/logo.png" };

describe("payment result page (core 1.79.0)", () => {
  it("paid: the shop's name and logo, the result, a summary of the payment and the way back", () => {
    const html = renderResultPage({ ...base, outcome: "paid", orderNo: "SKTEST1", amount: "NT$ 5", paymentType: "CREDIT", tradeNo: "26102121312835951", payTime: "2026-10-21 21:32:01" });
    expect(html).toContain("<title>付款完成｜測試商店</title>");
    expect(html).toContain('<img src="https://shop.example/logo.png" alt="" />');
    for (const text of ["付款完成", "訂單編號", "SKTEST1", "NT$ 5", "信用卡", "26102121312835951", "2026-10-21 21:32:01"]) expect(html).toContain(text);
    expect(html).toContain('<a class="btn primary" href="https://shop.example">返回網站</a>');
  });

  it("failed: says nothing was taken and shows no transaction number or payment time", () => {
    const html = renderResultPage({ ...base, outcome: "failed", orderNo: "SKTEST1", amount: "NT$ 5", tradeNo: "X1", payTime: "2026-10-21" });
    expect(html).toContain("未收取任何款項");
    expect(html).not.toContain("交易序號");
    expect(html).not.toContain("付款時間");
  });

  it("unknown: asks not to pay again and shows no summary", () => {
    const html = renderResultPage({ ...base, outcome: "unknown", orderNo: "SKTEST1" });
    expect(html).toContain("付款結果確認中");
    expect(html).toContain("請先不要重新付款");
    expect(html).not.toContain("訂單編號");
  });

  it("a logo only from https or the site itself; an unknown payment code is not shown", () => {
    expect(renderResultPage({ ...base, outcome: "paid", logoUrl: "/files/logo.png" })).toContain('src="https://shop.example/files/logo.png"');
    for (const logoUrl of ["javascript:alert(1)", "http://shop.example/logo.png", "//evil.example/x.png"]) {
      expect(renderResultPage({ ...base, outcome: "paid", logoUrl })).not.toContain("<img");
    }
    expect(renderResultPage({ ...base, outcome: "paid", paymentType: "SOMETHINGNEW" })).not.toContain("SOMETHINGNEW");
  });

  it("escapes what it shows", () => {
    const html = renderResultPage({ ...base, outcome: "paid", siteName: "<b>店</b>", orderNo: "\"><script>x</script>" });
    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toContain("<b>店</b>");
  });

  it("no site address: no button", () => {
    expect(renderResultPage({ ...base, siteUrl: "", outcome: "paid" })).not.toContain("返回網站");
  });
});

describe("test payment order numbers", () => {
  it("the admin test payment's numbers are recognised; the shop's are not", () => {
    expect(TEST_ORDER_PREFIX).toBe("SK");
    expect(isTestOrderNo("SKMVI5HAXF5JI3")).toBe(true);
    expect(isTestOrderNo("SM57E5373312B74BC2B168096F28A7")).toBe(false);
    expect(isTestOrderNo("SOMVI5HAXF5JI3ABCDEFGH")).toBe(false);
  });
});
