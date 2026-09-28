import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 商店:結帳完成頁的回報表單(伺服器端渲染)。欄位跟著收款方式的 reportSpec,稍後再回報的去處跟著
// 有沒有「我的訂單」這一頁。測的是出現什麼、必填有沒有掛上,不是樣式。

vi.mock("next/link", () => ({
  default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) => createElement("a", { href, className }, children),
}));

import { TransferReportForm } from "../extensions/shop/TransferReportForm";
import type { TransferReportSpec } from "../src/ext/payment-kit/report-spec";

const ORDER = "SM05B6686AD86846E598D347E15A91";
const spec = (ask: TransferReportSpec["ask"], label = "帳號末五碼", digits = 5): TransferReportSpec => ({ ask, reference: { label, digits } });
const render = (s: TransferReportSpec, extra: { email?: string; guest?: boolean; ordersHref?: string | null } = {}) =>
  renderToStaticMarkup(createElement(TransferReportForm, { spec: s, orderNo: ORDER, ordersHref: "/orders", ...extra }));
const input = (html: string, id: string) => html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? "";

describe("欄位照收款方式的設定", () => {
  it("預設:只有帳號末五碼一格,必填、5 位數字", () => {
    const html = render(spec("reference"));
    expect(html).toContain(">帳號末五碼</label>");
    expect(input(html, "shop-reference")).toContain("required");
    expect(input(html, "shop-reference")).toContain('inputMode="numeric"');
    expect(input(html, "shop-reference")).toContain('pattern="\\d{5}"');
    expect(html).not.toContain('id="shop-payer"');
    expect(html).not.toContain("填其中一項就可以");
  });

  it("自訂名稱與位數;0 位 = 不限格式", () => {
    const six = render(spec("reference", "轉帳後六碼", 6));
    expect(six).toContain(">轉帳後六碼</label>");
    expect(input(six, "shop-reference")).toContain('maxLength="6"');
    const free = render(spec("reference", "付款參考", 0));
    expect(input(free, "shop-reference")).not.toContain("inputMode");
    expect(input(free, "shop-reference")).toContain('maxLength="40"');
  });

  it("姓名:只有匯款人姓名一格,必填", () => {
    const html = render(spec("payerName"));
    expect(html).not.toContain('id="shop-reference"');
    expect(input(html, "shop-payer")).toContain("required");
  });

  it("擇一:兩格都在、都不是必填,說填一項就可以;兩個都要:兩格都必填", () => {
    const either = render(spec("either"));
    expect(input(either, "shop-reference")).not.toContain("required");
    expect(input(either, "shop-payer")).not.toContain("required");
    expect(either).toContain("填其中一項就可以。");
    const both = render(spec("both"));
    expect(input(both, "shop-reference")).toContain("required");
    expect(input(both, "shop-payer")).toContain("required");
  });
});

describe("稍後再回報的去處", () => {
  it("會員:我的訂單", () => {
    const html = render(spec("reference"));
    expect(html).toContain(">回報匯款</h2>");
    expect(html).toContain("送出回報</button>");
    expect(html).toContain('<a href="/orders" class="mx-0.5 underline underline-offset-4">我的訂單</a>');
    expect(html).not.toContain("訂單查詢");
  });

  it("訪客:訂單查詢,說回報時要用訂單編號和下單 Email;Email 不印在頁面上", () => {
    const html = render(spec("reference"), { email: "guest@example.com", guest: true });
    expect(html).toContain(">訂單查詢</a>");
    expect(html).toContain(ORDER);
    expect(html).toContain("和下單 Email 回報。");
    expect(html).not.toContain("guest@example.com");
  });

  it("沒有訂單頁:請客人記下訂單編號,不放連結", () => {
    const html = render(spec("reference"), { ordersHref: null });
    expect(html).toContain("請記下訂單編號");
    expect(html).toContain(ORDER);
    expect(html).not.toContain("<a ");
  });
});
