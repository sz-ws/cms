import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// core 1.52.0:角色與權限裡只拿到「檢視」的角色,商店的後台頁只列資料 —— 沒有動作按鈕、
// 表單與儲存(伺服器本來就回 403,這裡測的是畫面不再畫出一定會失敗的按鈕)。
// 頁面怎麼判斷「這一頁能不能改」是 canEditCurrentPage()(staff-access-render.test.ts 測它
// 對各角色的答案);這裡把它換成固定值,測每一頁拿到答案之後畫什麼。

const state = vi.hoisted(() => ({
  canEdit: true,
  levels: {} as Record<string, "none" | "view" | "edit">,
  orders: [] as unknown[],
  promos: [] as unknown[],
  /** 商品都已經申請退貨的訂單;"missing" = 退貨表還沒建。 */
  returned: [] as string[] | "missing",
  returnedAsked: [] as string[][],
}));

vi.mock("next/link", () => ({
  default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) =>
    createElement("a", { href, className }, children),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, prefetch: () => {} }),
  usePathname: () => "/admin/ext/shop",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/access-guards", () => ({ canEditCurrentPage: async () => state.canEdit }));
vi.mock("@/lib/access-api", () => ({
  adminPageLevels: async (_user: unknown, pages: Record<string, string>) =>
    Object.fromEntries(Object.keys(pages).map((name) => [name, state.levels[name] ?? "none"])),
}));
vi.mock("@/lib/auth", () => ({ requireAuth: async () => ({ id: "u1", role: "admin" }) }));
vi.mock("@/lib/settings", () => ({
  getSetting: async (key: string, fallback: unknown) => (key === "ext.shop.transferProvider" ? "banktransfer" : fallback),
}));
vi.mock("@/lib/db", () => ({ db: () => ({}) }));
vi.mock("@/lib/cf", () => ({ getDB: () => ({}) }));
vi.mock("@/ext/commerce-kit/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ext/commerce-kit/admin")>();
  return {
    ...actual,
    loadOrders: async (_table: string, opts: { status?: string } = {}) =>
      (state.orders as { status: string }[]).filter((o) => !opts.status || o.status === opts.status),
    loadStatusCounts: async () => ({ awaiting_verify: 1 }),
  };
});
vi.mock("@/ext/commerce-kit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ext/commerce-kit")>();
  return { ...actual, listPromos: async () => state.promos };
});
vi.mock("@/ext/commerce-kit/returns-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ext/commerce-kit/returns-engine")>();
  return {
    ...actual,
    createReturnsEngine: () => ({
      list: async () => [],
      counts: async () => ({}),
      fullyReturned: async (orderNos: string[]) => {
        state.returnedAsked.push(orderNos);
        if (state.returned === "missing") throw new Error("D1_ERROR: no such table: ext_shop_return_requests: SQLITE_ERROR");
        const returned = state.returned;
        return orderNos.filter((no) => returned.includes(no));
      },
    }),
  };
});

import { I18nProvider } from "../src/lib/i18n/I18nProvider";
import { getMessages } from "../src/lib/i18n";
import { ShopOrdersPage } from "../extensions/shop/admin-orders";
import { ShopVerifyPage } from "../extensions/shop/admin-verify";
import { ShopShippingPage } from "../extensions/shop/admin-shipping";
import { ShopPromosPage } from "../extensions/shop/admin-promos";
import { ReturnsAdminPage } from "../src/ext/commerce-kit/returns-admin";
import { SHOP_RETURNS } from "../extensions/shop/returns-config";
import type { CommerceOrder } from "../src/ext/commerce-kit/types";
import type { Promo } from "../src/ext/commerce-kit/promo";

const html = (node: ReactNode) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: "zh-Hant", messages: getMessages("zh-Hant") }, node));

const order = (orderNo: string, status: CommerceOrder["status"]): CommerceOrder => ({
  orderNo,
  status,
  lines: [{ productId: "p1", name: "示範商品", unitPrice: 300, qty: 1 }],
  amounts: { subtotal: 300, discount: 0, shipping: 0, total: 300 },
  paymentProvider: "banktransfer",
  customerName: "王小明",
  customerEmail: "a@example.com",
  customerPhone: "0912345678",
  shipAddress: null,
  region: null,
  shippingMethod: null,
  promoCode: null,
  transferLast5: status === "awaiting_verify" ? "12345" : null,
  transferReportedAt: null,
  note: null,
  createdAt: 1,
  updatedAt: 1,
});

const promo: Promo = {
  code: "WELCOME10",
  label: "",
  type: "percent",
  value: 10,
  minSubtotal: 0,
  maxUses: null,
  used: 0,
  startsAt: null,
  endsAt: null,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

const page = { params: {}, searchParams: {} };
/** 有沒有這顆按鈕(頁面說明文字裡也會出現同樣的字,所以認 <button>)。 */
const hasButton = (out: string, label: string) => new RegExp(`<button[^>]*>${label}</button>`).test(out);

/** 角色 × 這一頁的權限。預設的管理者每一頁都是「編輯」;自訂角色照它的授權。 */
const ROLES = [
  { role: "管理者", canEdit: true, levels: { verify: "edit", returns: "edit" } },
  { role: "自訂角色:這一頁可編輯,對帳佇列沒有", canEdit: true, levels: {} },
  { role: "自訂角色:這一頁只能看", canEdit: false, levels: { verify: "view" } },
] as const;

beforeEach(() => {
  state.canEdit = true;
  state.levels = {};
  state.orders = [order("SO1", "pending_payment"), order("SO2", "awaiting_verify"), order("SO3", "paid")];
  state.promos = [promo];
  state.returned = [];
  state.returnedAsked = [];
});

describe.each(ROLES)("$role", ({ canEdit, levels }) => {
  beforeEach(() => {
    state.canEdit = canEdit;
    state.levels = { ...levels };
  });

  it("訂單:能改才有訂單動作;打得開對帳佇列才有「待對帳」", async () => {
    const out = html(await ShopOrdersPage(page));
    expect(out).toContain("SO3");
    expect(hasButton(out, "標記出貨")).toBe(canEdit);
    expect(hasButton(out, "標記已收款")).toBe(canEdit);
    expect(out.includes('href="/admin/ext/shop/verify"')).toBe("verify" in levels);
  });

  it("對帳佇列:能改才有核可、退回與標記已收款", async () => {
    const out = html(await ShopVerifyPage());
    expect(out).toContain("SO2");
    expect(out).toContain("12345");
    expect(hasButton(out, "核可入帳")).toBe(canEdit);
    expect(hasButton(out, "退回")).toBe(canEdit);
    expect(hasButton(out, "標記已收款")).toBe(canEdit);
  });

  it("運費:能改才有新增、刪除、排序與儲存;欄位只能看時整組停用,試算照常", async () => {
    const out = html(await ShopShippingPage());
    expect(out).toContain("試算");
    expect(hasButton(out, "儲存運費設定")).toBe(canEdit);
    expect(hasButton(out, "\\+ 新增方式")).toBe(canEdit);
    expect(hasButton(out, "\\+ 新增規則")).toBe(canEdit);
    expect(/<fieldset disabled=""/.test(out)).toBe(!canEdit);
  });

  it("優惠碼:能改才有建立表單、編輯與刪除", async () => {
    const out = html(await ShopPromosPage());
    expect(out).toContain("WELCOME10");
    // 折 10% 寫成店家的說法,不混英文。
    expect(out).toContain("打 9 折");
    expect(out).not.toContain("% off");
    expect(out.includes("建立優惠碼")).toBe(canEdit);
    expect(hasButton(out, "刪除")).toBe(canEdit);
    expect(hasButton(out, "編輯")).toBe(canEdit);
  });

  it("退貨管理:能改才有新增退貨;?order= 不會替只能看的角色打開新增表單", async () => {
    const element = await ReturnsAdminPage({
      extId: "shop",
      slug: "returns",
      config: SHOP_RETURNS,
      ordersPage: "/admin/ext/shop",
      searchParams: { order: "SO9" },
    });
    expect(isValidElement(element)).toBe(true);
    const props = (element as ReactElement<{ canEdit: boolean; orderNo: string | null }>).props;
    expect(props.canEdit).toBe(canEdit);
    expect(props.orderNo).toBe(canEdit ? "SO9" : null);
    expect(html(element).includes("新增退貨")).toBe(canEdit);
  });
});

describe("商店的訂單頁:申請退貨", () => {
  const RETURN_LINK = (no: string) => `href="/admin/ext/shop/returns?order=${no}"`;
  beforeEach(() => {
    state.orders = [order("SO1", "pending_payment"), order("SO4", "shipped"), order("SO5", "completed")];
  });

  it.each([
    ["退貨管理可編輯", "edit", true],
    ["退貨管理只能看", "view", false],
    ["打不開退貨管理", "none", false],
  ] as const)("%s", async (_name, returns, offered) => {
    state.levels = { returns };
    const out = html(await ShopOrdersPage(page));
    expect(out.includes(RETURN_LINK("SO4"))).toBe(offered);
    expect(out.includes(RETURN_LINK("SO5"))).toBe(offered);
    // 還沒出貨的訂單本來就沒有。
    expect(out).not.toContain(RETURN_LINK("SO1"));
    // 不能建立退貨的人不必去查哪些已經退完。
    expect(state.returnedAsked).toEqual(offered ? [["SO4", "SO5"]] : []);
  });

  it("商品都已經申請退貨:不給連結,說一句;其他已出貨的照給", async () => {
    state.levels = { returns: "edit" };
    state.returned = ["SO5"];
    const out = html(await ShopOrdersPage(page));
    expect(out).toContain(RETURN_LINK("SO4"));
    expect(out).not.toContain(RETURN_LINK("SO5"));
    expect(out).toContain("商品都已申請退貨");
  });

  it("退貨表還沒建(商店還沒套用更新):當作沒有退完的,照給連結", async () => {
    state.levels = { returns: "edit" };
    state.returned = "missing";
    const out = html(await ShopOrdersPage(page));
    expect(out).toContain(RETURN_LINK("SO4"));
    expect(out).not.toContain("商品都已申請退貨");
  });
});
