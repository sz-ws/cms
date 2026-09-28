import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 商店 0.8.0:結帳完成頁的回報表單(伺服器端渲染)。欄位跟著受管訂單那一邊的設定(transferReport),
// 會員與訪客說的去處不同。測的是出現什麼、必填有沒有掛上,不是樣式。

vi.mock("next/link", () => ({
  default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) => createElement("a", { href, className }, children),
}));

import { TransferReportForm } from "../extensions/shop/TransferReportForm";
import type { TransferReportMode } from "../extensions/shop/transfer-report";

const ORDER = "SM05B6686AD86846E598D347E15A91";
const render = (mode: TransferReportMode, guestEmail?: string) =>
  renderToStaticMarkup(createElement(TransferReportForm, { mode, orderNo: ORDER, guestEmail }));
const input = (html: string, id: string) => html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? "";

describe("結帳完成頁的回報表單照站台設定", () => {
  it("末五碼:只有末五碼一格,必填", () => {
    const html = render("last5");
    expect(input(html, "shop-last5")).toContain("required");
    expect(input(html, "shop-last5")).toContain('inputMode="numeric"');
    expect(html).not.toContain('id="shop-payer"');
    expect(html).not.toContain("填其中一項就可以");
  });

  it("姓名:只有匯款人姓名一格,必填", () => {
    const html = render("name");
    expect(html).not.toContain('id="shop-last5"');
    expect(input(html, "shop-payer")).toContain("required");
    expect(html).toContain("匯款人姓名");
  });

  it("擇一:兩格都在、都不是必填,說填一項就可以", () => {
    const html = render("either");
    expect(input(html, "shop-last5")).not.toContain("required");
    expect(input(html, "shop-payer")).not.toContain("required");
    expect(html).toContain("填其中一項就可以。");
  });

  it("兩個都要:兩格都必填", () => {
    const html = render("both");
    expect(input(html, "shop-last5")).toContain("required");
    expect(input(html, "shop-payer")).toContain("required");
  });
});

describe("會員與訪客", () => {
  it("會員:稍後再回報的去處是我的訂單", () => {
    const html = render("last5");
    expect(html).toContain(">回報匯款</h2>");
    expect(html).toContain("送出回報</button>");
    expect(html).toContain('<a href="/shop/orders" class="mx-0.5 underline underline-offset-4">我的訂單</a>');
    expect(html).not.toContain("訂單查詢");
  });

  it("訪客:去處是訂單查詢,說回報時要用訂單編號和下單 Email", () => {
    const html = render("last5", "guest@example.com");
    expect(html).toContain(">訂單查詢</a>");
    expect(html).toContain(ORDER);
    expect(html).toContain("和下單 Email 回報。");
    // Email 只拿來送出回報,不會印在頁面上。
    expect(html).not.toContain("guest@example.com");
  });
});
