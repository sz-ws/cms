"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { useSiteCurrency } from "@/components/CurrencyProvider";
import type { CheckoutSession } from "@/ext/capabilities";
import { DEFAULT_TRANSFER_REPORT_SPEC, type TransferReportSpec } from "@/ext/payment-kit/report-spec";
import { formatMoney } from "@/ext/commerce-kit/money";
import type { PublicCheckoutField } from "@/ext/commerce-kit/checkout-fields";
import { forgetCheckoutValue, readCheckoutValue } from "@/ext/commerce-kit/checkout-prefill";
import {
  computeShippingOptions,
  shippingRegions,
  type ShippingConfig,
} from "@/ext/commerce-kit/shipping-engine";
import {
  cartSubtotal,
  clearCart,
  getCartServerSnapshot,
  getCartSnapshot,
  subscribeCart,
} from "./cart-store";
import { resolveCheckoutOptions, type CheckoutContact } from "./checkout-options";
import { CHECKOUT_URL, checkoutBody, explainCheckoutError, explainPromoError, requestFor, type CheckoutDraft } from "./checkout-request";
import { FIELD, LABEL, PRIMARY_BTN } from "./checkout-styles";
import { ExtraFields, OrderSummary, PaymentMethods, PromoField, ShippingChoices, type AppliedPromo } from "./CheckoutParts";
import { ManualResult, type ManualOrder } from "./CheckoutResult";

export { InstructionLines } from "./CheckoutResult";

// 結帳頁(client)。三種 session 結局:
//   form-post → 動態 <form> 送出跳轉 gateway(付款結果由回呼寫回)
//   redirect  → 直接導向
//   manual    → 清空購物車,顯示匯款指示 + 回報表單(CheckoutResult.tsx)
// 忙碌狀態為靜態文字(無 pulsing —— 專案紅線)。
//
// 運費/優惠碼(Phase 3–4):
//   - 配送選項用 shipping-engine 純函式即時試算(免 round-trip;伺服器結帳時
//     用同一個函式重算定案,這裡顯示的只是預覽)。收件地區的選項是運費設定的 regions。
//   - 優惠碼按「套用」打 promo-quote 預覽;真正核銷在結帳送出時(伺服器原子佔用)。
//
// 0.9.0:插件宣告的結帳欄位(fields,commerce-kit checkout-fields)。瀏覽器記下的值
// (checkout-prefill)先帶入;hidden 的不畫、只送記下的值。伺服器回 field_invalid 時忘掉那個值,
// hidden 的一併清掉,請客人再送一次。送出的 body 只有一種(checkout-request.ts)。
//
// 受管訂單(訂單管理插件接手結帳時,public-pages.tsx 照它的 storefront() 給 props):
//   - 伺服器可能要求登入(guest 以上)、電話與地址必填;開放訪客結帳(guestCheckout)時,沒登入也能
//     填表下單,頂端改成「已經是會員？登入」。它給了訂單頁(ordersHref)才放「我的訂單」的連結。
//   - 站台的殼可以給 onSignIn(按「登入」時換回自己的會員流程)與 afterOrder(結局頁下面多放一段,
//     例如請訪客設定密碼)。兩個都是函式,只能從 client 元件傳進來。
//   - 電話地址必填、結帳頁說明由 checkout-options.ts 正規化;這裡對 props 再跑一次
//     resolveCheckoutOptions,自訂殼層少給幾個 prop 也會得到一致的預設。

function submitToGateway(gatewayUrl: string, fields: Record<string, string>): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = gatewayUrl;
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

/** 沒給 signInHref 時的登入連結:/login 會轉到網站的登入頁,?next= 一起帶過去。 */
const DEFAULT_SIGN_IN_HREF = "/login?next=%2Fshop%2Fcheckout";

type CheckoutReply =
  | { ok: true; orderNo: string; session: CheckoutSession }
  | { ok: false; error: string; field?: string; message?: string };

/** 瀏覽器記下的結帳欄位值(微任務內讀,避開 effect 直接 setState 的 lint;已經填過的不蓋掉)。 */
function usePrefilledFields(fields: readonly PublicCheckoutField[]) {
  const [values, setValues] = useState<Record<string, string>>({});
  const names = fields.map((field) => field.name).join("\n");
  useEffect(() => {
    if (!names) return;
    Promise.resolve().then(() => {
      const stored = Object.fromEntries(
        names
          .split("\n")
          .map((name) => [name, readCheckoutValue(name)] as const)
          .filter(([, value]) => value !== ""),
      );
      if (Object.keys(stored).length > 0) setValues((prev) => ({ ...stored, ...prev }));
    });
  }, [names]);
  return [values, setValues] as const;
}

export function CheckoutView({
  cardEnabled,
  transferEnabled,
  shippingConfig = null,
  promoEnabled = false,
  managedOrders = false,
  signedIn = false,
  guestCheckout = false,
  ordersHref = null,
  reportSpec = DEFAULT_TRANSFER_REPORT_SPEC,
  fields = [],
  onSignIn,
  signInHref = DEFAULT_SIGN_IN_HREF,
  afterOrder,
  requireContact,
  notice = "",
  contact = {},
}: {
  cardEnabled: boolean;
  transferEnabled: boolean;
  /** 運費設定(null = 店家未啟用運費,不出現配送選擇)。 */
  shippingConfig?: ShippingConfig | null;
  /** 店家有啟用中的優惠碼才顯示輸入欄。 */
  promoEnabled?: boolean;
  /** 訂單管理插件接手結帳(`commerce:orders`)。 */
  managedOrders?: boolean;
  /** 受管模式下是否已登入;未登入顯示登入提示(伺服器會拒絕未登入的結帳)。 */
  signedIn?: boolean;
  /** 0.7.0:受管模式下開放訪客結帳(不擋登入,見 checkout-options.ts)。 */
  guestCheckout?: boolean;
  /** 0.9.0:客人看自己訂單的站內頁面(訂單管理插件的 storefront());沒有就不放「我的訂單」。 */
  ordersHref?: string | null;
  /** 0.9.0:匯款方式要客人回報什麼(收款的 manual provider 的 reportSpec);沒給 = 帳號末五碼。 */
  reportSpec?: TransferReportSpec;
  /** 0.9.0:插件宣告的結帳欄位(commerce-kit checkout-fields)。 */
  fields?: readonly PublicCheckoutField[];
  /** 0.7.0:按「登入」時要做的事;沒給就連到 signInHref。只能從 client 元件傳。 */
  onSignIn?: () => void;
  /** 「登入」連到哪(帶著回結帳頁的 ?next=);public-pages.tsx 給網站的登入頁,沒給是 /login(也會轉過去)。 */
  signInHref?: string;
  /** 0.7.0:匯款訂單成立後,結局頁下面多放的東西。只能從 client 元件傳。 */
  afterOrder?: (order: { orderNo: string; email: string }) => ReactNode;
  /** 電話與收件地址必填(設定 ext.shop.requireContact);受管模式照插件的 storefront(),沒給 = 必填。 */
  requireContact?: boolean;
  /** 結帳頁最上方的說明(設定 ext.shop.checkoutNotice);空 = 不顯示。 */
  notice?: string;
  /** 0.7.0:表單一開始帶入的姓名與 Email(已登入的人,見 checkoutContact)。 */
  contact?: CheckoutContact;
}) {
  const options = resolveCheckoutOptions({
    managedOrders,
    signedIn,
    guestCheckout,
    requireContact,
    ordersHref,
    checkoutNotice: notice,
  });
  const items = useSyncExternalStore(subscribeCart, getCartSnapshot, getCartServerSnapshot);
  const currency = useSiteCurrency();
  const money = (amount: number) => formatMoney(amount, currency);
  const [name, setName] = useState(contact.name ?? "");
  const [email, setEmail] = useState(contact.email ?? "");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [region, setRegion] = useState("");
  const [shipChoice, setShipChoice] = useState<string | null>(null);
  const [promoInput, setPromoInput] = useState("");
  const [promo, setPromo] = useState<AppliedPromo | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [method, setMethod] = useState<"card" | "transfer">(cardEnabled ? "card" : "transfer");
  const [fieldValues, setFieldValues] = usePrefilledFields(fields);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState<ManualOrder | null>(null);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const noMethods = !cardEnabled && !transferEnabled;

  const subtotal = cartSubtotal(items);
  const totalQty = items.reduce((n, i) => n + i.qty, 0);
  // 配送選項即時試算(與伺服器同一個純函式;region 一改整排重算)。
  const shipOptions = useMemo(
    () =>
      shippingConfig
        ? computeShippingOptions({ subtotal, qty: totalQty, region: region || undefined }, shippingConfig)
        : [],
    [shippingConfig, subtotal, totalQty, region],
  );
  // 選擇不在目前選項裡(如地區改變)→ 落回第一個。
  const selectedShip = shipOptions.find((o) => o.id === shipChoice) ?? shipOptions[0] ?? null;
  const shippingFee = promo?.freeShipping ? 0 : (selectedShip?.fee ?? 0);
  const total = subtotal - (promo?.discount ?? 0) + shippingFee;

  async function applyPromo() {
    const code = promoInput.trim().toUpperCase();
    if (!code || busy) return;
    setPromoError(null);
    try {
      const res = await fetch("/api/ext/shop/promo-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, subtotal }),
      });
      const data = (await res.json()) as
        | ({ ok: true } & AppliedPromo)
        | { ok: false; error: string; reason?: string };
      if (!data.ok) {
        setPromo(null);
        setPromoError(explainPromoError(data.error, data.reason));
        return;
      }
      setPromo({ code: data.code, label: data.label, discount: data.discount, freeShipping: data.freeShipping });
    } catch {
      setPromoError("網路錯誤，請重試。");
    }
  }

  /** 伺服器拒絕一個結帳欄位:忘掉瀏覽器記下的那個值;hidden 的沒有地方讓客人改,一併清掉、請他再送一次。 */
  function rejectField(field: string, message: string | undefined) {
    forgetCheckoutValue(field, (fieldValues[field] ?? "").trim());
    if (fields.find((f) => f.name === field)?.input === "hidden") {
      setFieldValues((prev) => Object.fromEntries(Object.entries(prev).filter(([name]) => name !== field)));
    }
    setError(message || explainCheckoutError("field_invalid"));
  }

  function showSession(orderNo: string, session: CheckoutSession) {
    if (!session.ok) {
      setError(explainCheckoutError(session.error));
      return;
    }
    if (session.kind === "form-post") {
      submitToGateway(session.gatewayUrl, session.fields);
      return; // 離頁;購物車保留,付款失敗回來還在。
    }
    if (session.kind === "redirect") {
      window.location.href = session.url;
      return;
    }
    // manual:訂單已成立,顯示匯款指示。
    clearCart();
    setManual({ orderNo, instructions: session.instructions, note: session.note, email: email.trim() });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || items.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const draft: CheckoutDraft = {
        items, name, email, phone, address, region,
        shippingMethodId: selectedShip?.id ?? "",
        promoCode: promo?.code,
        method,
        fields: fieldValues,
      };
      request.current = requestFor(request.current, draft, () => crypto.randomUUID());
      const res = await fetch(CHECKOUT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(checkoutBody(draft, request.current.id)),
      });
      const data = (await res.json()) as CheckoutReply;
      if (!data.ok) {
        if (data.error === "field_invalid" && data.field) rejectField(data.field, data.message);
        else setError(explainCheckoutError(data.error));
        return;
      }
      request.current = null;
      showSession(data.orderNo, data.session);
    } catch {
      setError("網路錯誤，請重試。");
    } finally {
      setBusy(false);
    }
  }

  // 訪客下的受管訂單:沒有「我的訂單」,改用訂單編號查詢(0.7.0)。
  const asGuest = options.guestCheckout && !options.signedIn;
  const signInLink = onSignIn ? (
    <button type="button" onClick={onSignIn} className="ml-1 underline underline-offset-4">
      登入
    </button>
  ) : (
    <Link href={signInHref} className="ml-1 underline underline-offset-4">
      登入
    </Link>
  );

  // 結局頁:匯款指示 + 回報匯款。
  if (manual) {
    return (
      <ManualResult
        order={manual}
        spec={reportSpec}
        asGuest={asGuest}
        managed={options.managedOrders}
        ordersHref={options.ordersHref}
        afterOrder={afterOrder}
      />
    );
  }

  if (items.length === 0) {
    return (
      <p className="text-[14px] text-black/60">
        購物車是空的，先去
        <Link href="/shop/cart" className="underline underline-offset-4">
          購物車
        </Link>
        看看。
      </p>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-5">
      {options.notice ? (
        <p className="whitespace-pre-line text-[13.5px] leading-relaxed text-black/70">{options.notice}</p>
      ) : null}
      {asGuest ? (
        <p className="text-[13.5px] text-black/60">已經是會員？{signInLink}</p>
      ) : options.managedOrders ? (
        // 一行兩段,中間用 · 隔開:句尾不加句號(「。 ·」兩個標點撞在一起)。
        <p className="text-[13.5px] text-black/60">
          {options.signedIn ? (
            "已登入會員"
          ) : (
            <>
              結帳前請先
              <Link href={signInHref} className="mx-0.5 underline underline-offset-4">
                登入
              </Link>
              會員
            </>
          )}
          {options.ordersHref ? (
            <>
              {" · "}
              <Link href={options.ordersHref} className="underline underline-offset-4">
                我的訂單
              </Link>
            </>
          ) : null}
        </p>
      ) : null}

      <OrderSummary
        items={items}
        subtotal={subtotal}
        promo={promo}
        shipping={selectedShip ? { name: selectedShip.name, fee: shippingFee } : null}
        total={total}
        money={money}
      />

      <div>
        <label htmlFor="shop-name" className={LABEL}>
          姓名
        </label>
        <input id="shop-name" className={FIELD} required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label htmlFor="shop-email" className={LABEL}>
          Email
        </label>
        <input id="shop-email" className={FIELD} type="email" required maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <label htmlFor="shop-phone" className={LABEL}>
          {options.requireContact ? "電話" : "電話（選填）"}
        </label>
        <input id="shop-phone" required={options.requireContact} type="tel" className={FIELD} maxLength={30} value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      {shippingConfig ? (
        <div>
          <label htmlFor="shop-region" className={LABEL}>
            收件地區
          </label>
          <select id="shop-region" className={FIELD} value={region} onChange={(e) => setRegion(e.target.value)}>
            <option value="">請選擇</option>
            {shippingRegions(shippingConfig).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div>
        <label htmlFor="shop-address" className={LABEL}>
          {options.requireContact ? "收件地址" : "收件地址（選填）"}
        </label>
        <input id="shop-address" required={options.requireContact} className={FIELD} maxLength={200} value={address} onChange={(e) => setAddress(e.target.value)} />
      </div>

      <ShippingChoices options={shipOptions} selected={selectedShip?.id ?? null} onSelect={setShipChoice} money={money} />

      {promoEnabled ? (
        <PromoField
          promo={promo}
          input={promoInput}
          error={promoError}
          busy={busy}
          onInput={(value) => {
            setPromoInput(value);
            setPromoError(null);
          }}
          onApply={() => void applyPromo()}
          onRemove={() => {
            setPromo(null);
            setPromoInput("");
          }}
          money={money}
        />
      ) : null}

      <ExtraFields
        fields={fields}
        values={fieldValues}
        onChange={(fieldName, value) => setFieldValues((prev) => ({ ...prev, [fieldName]: value }))}
      />

      <PaymentMethods cardEnabled={cardEnabled} transferEnabled={transferEnabled} method={method} onSelect={setMethod} />

      {error ? <p className="text-[13px] text-red-700">{error}</p> : null}

      <button type="submit" disabled={busy || noMethods} className={PRIMARY_BTN}>
        {busy ? "處理中…" : method === "card" ? "前往付款" : "成立訂單，取得匯款帳號"}
      </button>
      {noMethods ? (
        <p className="text-center text-[12.5px] text-black/60">目前沒有可用的付款方式（店家尚未設定）。</p>
      ) : null}
    </form>
  );
}
