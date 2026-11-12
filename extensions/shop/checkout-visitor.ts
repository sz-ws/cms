import { checkoutContact, type CheckoutContact } from "./checkout-options";

// 2.0:結帳頁(/shop/checkout)是存起來的公開頁 —— 同一份 HTML 給每個訪客,伺服器渲染時不讀 session
// (讀了 Next 會擋:那一頁 dynamic = "error")。「這位訪客登入了沒、要帶入哪個姓名與 Email」改由
// CheckoutView 在頁面出現之後問這裡。回應因人而異,所以 private, no-store。

export interface CheckoutVisitor {
  signedIn: boolean;
  contact: CheckoutContact;
}

/** GET /api/ext/shop/checkout-visitor(公開;沒登入回 signedIn: false)。 */
export async function checkoutVisitorHandler(): Promise<Response> {
  const { getSessionUser } = await import("@/lib/auth");
  const user = await getSessionUser();
  const body: CheckoutVisitor = { signedIn: user !== null, contact: checkoutContact(user) };
  return Response.json(body, { headers: { "cache-control": "private, no-store" } });
}
