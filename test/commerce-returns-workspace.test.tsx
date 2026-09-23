import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 退貨管理畫面(commerce-kit 1.50.0)的伺服器端渲染:列表、篩選、表還沒建時的提示,
// 以及明細裡「下一步」依狀態給的選項與欄位。測的是有沒有出現、字典有沒有接上,不是樣式。

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => createElement("a", { href }, children),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, prefetch: () => {} }),
  usePathname: () => "/admin/ext/shop/returns",
}));

import { I18nProvider } from "../src/lib/i18n/I18nProvider";
import { getMessages } from "../src/lib/i18n";
import { ReturnsWorkspace, type ReturnsWorkspaceProps } from "../src/ext/commerce-kit/ReturnsWorkspace";
import { ActionForm, Summary } from "../src/ext/commerce-kit/ReturnDetailSheet";
import type { ReturnStatus, ShopReturn } from "../src/ext/commerce-kit/returns";
import type { ReturnDetail } from "../src/ext/commerce-kit/returns-ui";

const zh = (node: ReactNode) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: "zh-Hant", messages: getMessages("zh-Hant") }, node));

const RETURN: ShopReturn = {
  returnNo: "RTABC123",
  orderNo: "SO42",
  status: "requested",
  lines: [
    { productId: "p1", name: "商品一", unitPrice: 300, qty: 2, restocked: 0 },
    { productId: "p2", name: "商品二", unitPrice: 150, qty: 1, restocked: 0 },
  ],
  reason: "defective",
  note: "外盒破損",
  requestedAmount: 750,
  refund: null,
  customerName: "王小明",
  customerPhone: "0912345678",
  createdBy: "u1",
  createdAt: Date.UTC(2026, 8, 20, 4, 0),
  updatedAt: Date.UTC(2026, 8, 20, 4, 0),
};

const props = (over: Partial<ReturnsWorkspaceProps> = {}): ReturnsWorkspaceProps => ({
  rows: [RETURN],
  counts: { requested: 1, refunded: 2 },
  status: null,
  search: "",
  ready: true,
  limit: 200,
  endpoint: "/api/ext/shop",
  pageHref: "/admin/ext/shop/returns",
  ordersPage: "/admin/ext/shop",
  statusRef: "shop:returns",
  openNo: null,
  orderNo: null,
  ...over,
});

const detail = (status: ReturnStatus, over: Partial<ReturnDetail> = {}): ReturnDetail => ({
  return: { ...RETURN, status },
  events: [],
  order: { status: "completed", subtotal: 750, discount: 0, total: 750, refunded: 0 },
  stock: { enabled: true, tracked: { p1: true, p2: false }, taken: { p1: true, p2: false } },
  ...over,
});

describe("退貨管理列表", () => {
  it("標題、新增鈕、狀態篩選(含筆數、保留搜尋條件)與一列退貨", () => {
    const html = zh(createElement(ReturnsWorkspace, props({ search: "q=SO42" })));
    expect(html).toContain("退貨管理");
    expect(html).toContain("新增退貨");
    expect(html).toMatch(/全部<span[^>]*>3<\/span>/);
    expect(html).toMatch(/申請中<span[^>]*>1<\/span>/);
    expect(html).toContain('href="/admin/ext/shop/returns?q=SO42&amp;status=refunded"');
    expect(html).toContain("RTABC123");
    expect(html).toContain("SO42");
    expect(html).toContain("2 項");
    expect(html).toContain("NT$ 750");
    expect(html).toContain("共找到 1 筆");
  });

  it("表還沒建:請店家先套用商店的更新,新增鈕停用", () => {
    const html = zh(createElement(ReturnsWorkspace, props({ rows: [], counts: {}, ready: false })));
    expect(html).toContain("要先在擴充功能頁按商店的「套用更新」，才能使用退貨。");
    expect(html).toContain('href="/admin/extensions"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>新增退貨<\/button>/);
    expect(html).toContain("還沒有退貨。");
  });
});

describe("退貨明細", () => {
  it("品項、客人、訂單連結、原因與申請金額", () => {
    const html = zh(createElement(Summary, { detail: detail("requested"), ordersPage: "/admin/ext/shop" }));
    expect(html).toContain("商品一 × 2");
    expect(html).toContain('href="/admin/ext/shop?q=SO42&amp;open=SO42"');
    expect(html).toContain("商品瑕疵或損壞");
    expect(html).toContain("外盒破損");
    expect(html).toContain("NT$ 750");
  });

  it("申請中:同意、拒絕、取消三個選項,預設同意", () => {
    const html = zh(createElement(ActionForm, { detail: detail("requested"), busy: false, onSubmit: () => {} }));
    expect(html).toMatch(/aria-checked="true"[^>]*>同意退貨</);
    expect(html).toContain("拒絕退貨");
    expect(html).toContain("取消退貨");
    expect(html).toMatch(/<button type="submit"[^>]*>同意退貨<\/button>/);
  });

  it("已同意:預設收到退貨,放回庫存要勾選(預設不勾)", () => {
    const html = zh(createElement(ActionForm, { detail: detail("approved"), busy: false, onSubmit: () => {} }));
    expect(html).toMatch(/aria-checked="true"[^>]*>收到退貨</);
    expect(html).toContain("直接退款，不收回商品");
    const checkbox = html.match(/<input type="checkbox"[^>]*name="restock"[^>]*>/)?.[0] ?? "";
    expect(checkbox).not.toBe("");
    expect(checkbox).not.toContain("checked");
    // 沒勾之前不出現逐項件數。
    expect(html).not.toContain('name="restock:p1"');
  });

  it("這張訂單沒從庫存扣過任何一項:不給勾放回庫存,只說收到退貨不會改動庫存", () => {
    const stock = { enabled: true, tracked: { p1: true, p2: true }, taken: { p1: false, p2: false } };
    const html = zh(createElement(ActionForm, { detail: detail("approved", { stock }), busy: false, onSubmit: () => {} }));
    expect(html).not.toContain('name="restock"');
    expect(html).toContain("這張訂單沒有從庫存扣過這些商品，收到退貨不會改動庫存。");
  });

  it("已收到退貨:登記退款說清楚系統不會自動退款,金額預設申請金額", () => {
    const html = zh(createElement(ActionForm, { detail: detail("received"), busy: false, onSubmit: () => {} }));
    expect(html).toContain("系統不會自動退款。請先在金流後台或網路銀行把錢退給客人，再到這裡登記。");
    expect(html).toMatch(/name="amount"[^>]*value="750"/);
    expect(html).toContain("最多 NT$ 750");
    expect(html).toContain("原付款方式退回");
  });

  it("退款上限是這筆退貨的商品金額加運費,提示說出含多少運費", () => {
    // 商品 750、運費 150 → 訂單 900;這筆只退一件 150 元的商品二。
    const one = { ...RETURN, status: "received" as const, lines: [RETURN.lines[1]], requestedAmount: 150 };
    const order = { status: "completed" as const, subtotal: 750, discount: 0, total: 900, refunded: 0 };
    const html = zh(createElement(ActionForm, { detail: detail("received", { return: one, order }), busy: false, onSubmit: () => {} }));
    expect(html.match(/<input[^>]*name="amount"[^>]*>/)?.[0]).toContain(`max="300"`);
    expect(html).toContain("最多 NT$ 300（含運費 NT$ 150）");
    expect(html).not.toContain("NT$ 900");
    // 訂單只剩 100 可退:上限 100,裡面沒有運費。
    const left = zh(createElement(ActionForm, { detail: detail("received", { return: one, order: { ...order, refunded: 800 } }), busy: false, onSubmit: () => {} }));
    expect(left).toContain("最多 NT$ 100<");
    expect(left).not.toContain("含運費");
  });

  it("英文介面:Up to … (includes … shipping)", () => {
    const one = { ...RETURN, status: "received" as const, lines: [RETURN.lines[1]], requestedAmount: 150 };
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        { locale: "en", messages: getMessages("en") },
        createElement(ActionForm, {
          detail: detail("received", { return: one, order: { status: "completed", subtotal: 750, discount: 0, total: 900, refunded: 0 } }),
          busy: false,
          onSubmit: () => {},
        }),
      ),
    );
    expect(html).toContain("Up to NT$ 300 (includes NT$ 150 shipping)");
  });

  it("結案類的一步提示送出後不能再改;終態沒有下一步", () => {
    expect(zh(createElement(ActionForm, { detail: detail("refunded"), busy: false, onSubmit: () => {} }))).toContain(
      "送出後這筆退貨就結束，不能再改。",
    );
    expect(zh(createElement(ActionForm, { detail: detail("completed"), busy: false, onSubmit: () => {} }))).toBe("");
  });
});
