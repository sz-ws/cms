"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import type { CheckoutSession, ManualInstructionLine } from "@/ext/capabilities";
import {
  computeShippingOptions,
  type ShippingConfig,
} from "@/ext/commerce-kit/shipping-engine";
import {
  cartSubtotal,
  clearCart,
  getCartServerSnapshot,
  getCartSnapshot,
  subscribeCart,
} from "./cart-store";
import { resolveCheckoutOptions, type ReferralMode } from "./checkout-options";

// 結帳頁(client)。三種 session 結局:
//   form-post → 動態 <form> 送出跳轉 gateway(付款結果由回呼寫回)
//   redirect  → 直接導向
//   manual    → 顯示匯款指示 + 末五碼回報表單(回報後清空購物車)
// 忙碌狀態為靜態文字(無 pulsing —— 專案紅線)。
//
// 運費/優惠碼(Phase 3–4):
//   - 配送選項用 shipping-engine 純函式即時試算(免 round-trip;伺服器結帳時
//     用同一個函式重算定案,這裡顯示的只是預覽)。
//   - 優惠碼按「套用」打 promo-quote 預覽;真正核銷在結帳送出時(伺服器原子佔用)。
//
// 受管訂單(0.2.0,shop-operations 啟用時):
//   - 同一個 POST /api/ext/shop/checkout,但多帶 requestId(重送不重複建單)與
//     referralCode;伺服器要求登入(guest 以上)、電話與地址必填。
//   - 匯款回報改打 /api/ext/shop-operations/actions(action:"report")。
//   - 三個開關(推薦碼欄位、電話地址必填、結帳頁說明)由 checkout-options.ts
//     正規化;這裡對 props 再跑一次 resolveCheckoutOptions,自訂殼層少給幾個
//     prop 也會得到一致的預設。

/** 收件地區(台灣縣市)。引擎只做字串比對 —— 這份清單是 UI 層的事。 */
const TW_REGIONS = [
  "臺北市", "新北市", "基隆市", "桃園市", "新竹市", "新竹縣", "苗栗縣",
  "臺中市", "彰化縣", "南投縣", "雲林縣", "嘉義市", "嘉義縣", "臺南市",
  "高雄市", "屏東縣", "宜蘭縣", "花蓮縣", "臺東縣", "澎湖縣", "金門縣", "連江縣",
];

const FIELD =
  "h-11 w-full rounded-[10px] bg-white px-3.5 text-[14px] text-black/85 " +
  "shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)] outline-none " +
  "focus:shadow-[inset_0_0_0_1.5px_rgba(0,0,0,0.6)]";
const LABEL = "mb-1.5 block text-[12.5px] text-black/55";
const PRIMARY_BTN =
  "grid h-11 w-full place-items-center rounded-[12px] bg-black text-[14.5px] " +
  "font-medium text-white hover:bg-black/85 disabled:opacity-50";

const ERROR_HINT: Record<string, string> = {
  invalid_input: "資料不完整或格式不對,請檢查後再送出。",
  unknown_product: "購物車內有商品已下架,請回購物車移除後重試。",
  unpriced_product: "購物車內有商品目前無法結帳,請回購物車移除後重試。",
  invalid_total: "訂單金額不正確。",
  invalid_shipping: "請選擇配送方式。",
  promo_invalid: "優惠碼無法使用,請移除後重試。",
  method_not_enabled: "此付款方式目前未開放。",
  not_available: "付款服務暫時無法使用,請稍後再試。",
  not_configured: "付款方式尚未設定完成,請聯絡店家。",
  rate_limited: "嘗試次數過多,請稍後再試。",
  referral_invalid: "這組推薦碼無法使用，請先移除後再結帳。",
  referral_self: "無法使用自己的推薦碼，請先移除後再結帳。",
};

const REFERRAL_KEY = "shop.referral.v1";

/** 推薦碼只由推薦連結帶入(referralMode "link")時沒有欄位可移除,改為自動移除後請客人再送一次。 */
const LINK_REFERRAL_HINT: Record<string, string> = {
  referral_invalid: "推薦連結已失效，請重新送出。",
  referral_self: "無法使用自己的推薦連結，請重新送出。",
};

/** Drop the stored link attribution once the server rejects it, so the next checkout doesn't prefill it again. */
function forgetStoredReferral(code: string) {
  try {
    const stored = JSON.parse(localStorage.getItem(REFERRAL_KEY) || "null");
    if (stored?.code === code) localStorage.removeItem(REFERRAL_KEY);
  } catch {
    /* optional browser attribution */
  }
}

const PROMO_REASON: Record<string, string> = {
  not_found: "查無此優惠碼。",
  disabled: "此優惠碼已停用。",
  not_started: "此優惠碼尚未開始。",
  expired: "此優惠碼已過期。",
  exhausted: "此優惠碼已被用完。",
  below_min_subtotal: "未達此優惠碼的低消門檻。",
};

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

interface ManualState {
  orderNo: string;
  instructions: ManualInstructionLine[];
  note?: string;
}

interface AppliedPromo {
  code: string;
  label: string;
  discount: number;
  freeShipping: boolean;
}

export function CheckoutView({
  cardEnabled,
  transferEnabled,
  shippingConfig = null,
  promoEnabled = false,
  managedOrders = false,
  signedIn = false,
  referralMode,
  requireContact = false,
  notice = "",
}: {
  cardEnabled: boolean;
  transferEnabled: boolean;
  /** 運費設定(null = 店家未啟用運費,不出現配送選擇)。 */
  shippingConfig?: ShippingConfig | null;
  /** 店家有啟用中的優惠碼才顯示輸入欄。 */
  promoEnabled?: boolean;
  /** shop-operations 啟用中:結帳走受管訂單(需登入、電話與地址必填)。 */
  managedOrders?: boolean;
  /** 受管模式下是否已登入;未登入顯示登入提示(伺服器會拒絕未登入的結帳)。 */
  signedIn?: boolean;
  /** 推薦碼欄位模式(設定 ext.shop.referralMode);未給 = 受管時 "field"。非受管一律無效。 */
  referralMode?: ReferralMode;
  /** 電話與收件地址必填(設定 ext.shop.requireContact);受管模式一律必填。 */
  requireContact?: boolean;
  /** 結帳頁最上方的說明(設定 ext.shop.checkoutNotice);空 = 不顯示。 */
  notice?: string;
}) {
  const options = resolveCheckoutOptions({
    managedOrders,
    signedIn,
    referralMode,
    requireContact,
    checkoutNotice: notice,
  });
  const items = useSyncExternalStore(
    subscribeCart,
    getCartSnapshot,
    getCartServerSnapshot,
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [region, setRegion] = useState("");
  const [shipChoice, setShipChoice] = useState<string | null>(null);
  const [promoInput, setPromoInput] = useState("");
  const [promo, setPromo] = useState<AppliedPromo | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [method, setMethod] = useState<"card" | "transfer">(
    cardEnabled ? "card" : "transfer",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState<ManualState | null>(null);
  const [last5, setLast5] = useState("");
  const [reported, setReported] = useState(false);

  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const [referralCode, setReferralCode] = useState("");
  const referral = options.referralMode;
  useEffect(() => {
    if (referral === "off") return;
    // 推薦連結(?ref=)存進瀏覽器的推薦碼;"field" 先填進欄位讓客人看得到、能移除,
    // "link" 則靜默帶上。微任務內 setState,避開 effect 直接 setState 的 lint。
    Promise.resolve().then(() => {
      try {
        const stored = JSON.parse(localStorage.getItem(REFERRAL_KEY) || "null");
        if (stored && typeof stored.code === "string" && stored.expiresAt > Date.now()) {
          setReferralCode(stored.code);
        }
      } catch {
        /* optional browser attribution */
      }
    });
  }, [referral]);
  const noMethods = !cardEnabled && !transferEnabled;

  const subtotal = cartSubtotal(items);
  const totalQty = items.reduce((n, i) => n + i.qty, 0);
  // 配送選項即時試算(與伺服器同一個純函式;region 一改整排重算)。
  const shipOptions = useMemo(
    () =>
      shippingConfig
        ? computeShippingOptions(
            { subtotal, qty: totalQty, region: region || undefined },
            shippingConfig,
          )
        : [],
    [shippingConfig, subtotal, totalQty, region],
  );
  // 選擇不在目前選項裡(如地區改變)→ 落回第一個。
  const selectedShip =
    shipOptions.find((o) => o.id === shipChoice) ?? shipOptions[0] ?? null;
  const shippingFee = promo?.freeShipping ? 0 : (selectedShip?.fee ?? 0);
  const discount = promo?.discount ?? 0;
  const total = subtotal - discount + shippingFee;

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
        | { ok: true; code: string; label: string; discount: number; freeShipping: boolean }
        | { ok: false; error: string; reason?: string };
      if (!data.ok) {
        setPromo(null);
        setPromoError(
          (data.reason && PROMO_REASON[data.reason]) ??
            ERROR_HINT[data.error] ??
            "優惠碼無法使用。",
        );
        return;
      }
      setPromo({
        code: data.code,
        label: data.label,
        discount: data.discount,
        freeShipping: data.freeShipping,
      });
    } catch {
      setPromoError("網路錯誤,請重試。");
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !items || items.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const fingerprint = JSON.stringify({ items, name, email, phone, address, region, selectedShip, promo, method, referralCode });
      if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
      const res = await fetch("/api/ext/shop/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(options.managedOrders
            ? {
                requestId: request.current.id,
                ...(referral !== "off" && referralCode.trim()
                  ? { referralCode: referralCode.trim().toUpperCase() }
                  : {}),
              }
            : {}),
          items: items.map((i) => ({ productId: i.productId, qty: i.qty })),
          name: name.trim(),
          email: email.trim(),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(address.trim() ? { address: address.trim() } : {}),
          ...(region ? { region } : {}),
          // 受管訂單要求一定要有配送方式:店家還沒設運費時送空字串,讓伺服器回
          // 「請先設定配送方式與運費」而不是籠統的格式錯誤。
          ...(selectedShip
            ? { shippingMethodId: selectedShip.id }
            : options.managedOrders
              ? { shippingMethodId: "" }
              : {}),
          ...(promo ? { promoCode: promo.code } : {}),
          method,
        }),
      });
      const data = (await res.json()) as
        | { ok: true; orderNo: string; session: CheckoutSession }
        | { ok: false; error: string };
      if (!data.ok) {
        if (data.error === "referral_invalid" || data.error === "referral_self") {
          forgetStoredReferral(referralCode.trim().toUpperCase());
          if (referral === "link") {
            // 沒有欄位可讓客人移除:清掉後直接請客人再送一次(換新的 requestId)。
            setReferralCode("");
            setError(LINK_REFERRAL_HINT[data.error]);
            return;
          }
        }
        setError(ERROR_HINT[data.error] ?? `結帳失敗:${data.error}`);
        return;
      }
      request.current = null;
      const session = data.session;
      if (!session.ok) {
        setError(ERROR_HINT[session.error] ?? `結帳失敗:${session.error}`);
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
      setManual({
        orderNo: data.orderNo,
        instructions: session.instructions,
        note: session.note,
      });
    } catch {
      setError("網路錯誤,請重試。");
    } finally {
      setBusy(false);
    }
  }

  async function report(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !manual) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        options.managedOrders
          ? "/api/ext/shop-operations/actions"
          : "/api/ext/shop/transfer-report",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(options.managedOrders ? { action: "report" } : {}),
            orderNo: manual.orderNo,
            last5,
          }),
        },
      );
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        setError(
          data.error === "invalid_input"
            ? "末五碼需為 5 位數字。"
            : (ERROR_HINT[data.error ?? ""] ?? "回報失敗,請重試。"),
        );
        return;
      }
      setReported(true);
    } catch {
      setError("網路錯誤,請重試。");
    } finally {
      setBusy(false);
    }
  }

  // 結局頁:匯款指示 / 回報完成。
  if (manual) {
    return (
      <div className="flex flex-col gap-6">
        <div className="rounded-[14px] bg-white px-6 py-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]">
          <p className="text-[13px] text-black/55">
            {options.managedOrders
              ? "訂單已成立，請依「我的訂單」顯示的付款期限付款。"
              : "訂單已成立,請於三日內匯款至以下帳戶:"}
          </p>
          <dl className="mt-4 space-y-2.5">
            {manual.instructions.map((line) => (
              <div key={line.label} className="flex items-baseline gap-3">
                <dt className="w-20 shrink-0 text-[12.5px] text-black/60">
                  {line.label}
                </dt>
                <dd className="font-mono text-[14px] text-black/85">
                  {line.value}
                </dd>
              </div>
            ))}
          </dl>
          {manual.note ? (
            <p className="mt-4 text-[12.5px] leading-relaxed text-black/60">
              {manual.note}
            </p>
          ) : null}
        </div>

        {reported ? (
          <div className="text-center">
            <div className="text-[32px]">✓</div>
            <h2 className="mt-2 text-[18px] font-semibold tracking-[-0.01em] text-black/85">
              已收到您的回報
            </h2>
            <p className="mt-1.5 text-[13.5px] text-black/55">
              訂單 <span className="font-mono">{manual.orderNo}</span>{" "}
              對帳完成後即為您處理。
            </p>
            <Link
              href="/"
              className="mt-6 inline-block text-[13.5px] text-black/70 underline underline-offset-4"
            >
              返回網站
            </Link>
          </div>
        ) : (
          <form onSubmit={(e) => void report(e)} className="flex flex-col gap-3">
            <div>
              <label htmlFor="shop-last5" className={LABEL}>
                匯款完成後,回報您的帳號末五碼
              </label>
              <input
                id="shop-last5"
                className={FIELD}
                inputMode="numeric"
                pattern="\d{5}"
                maxLength={5}
                required
                value={last5}
                onChange={(e) => setLast5(e.target.value.replace(/\D/g, ""))}
                placeholder="12345"
              />
            </div>
            {error ? (
              <p className="text-[13px] text-red-700">{error}</p>
            ) : null}
            <button type="submit" disabled={busy || last5.length !== 5} className={PRIMARY_BTN}>
              {busy ? "送出中…" : "回報已匯款"}
            </button>
            <p className="text-center text-[12px] text-black/60">
              稍後再匯也沒關係 —— 記下訂單編號
              <span className="font-mono"> {manual.orderNo} </span>
              即可。
            </p>
          </form>
        )}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <p className="text-[14px] text-black/60">
        購物車是空的,先去
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
        <p className="whitespace-pre-line text-[13.5px] leading-relaxed text-black/70">
          {options.notice}
        </p>
      ) : null}
      {options.managedOrders ? (
        <p className="text-[13.5px] text-black/60">
          {options.signedIn ? (
            "已登入會員。"
          ) : (
            <>
              請先登入會員後結帳。
              <Link
                href="/login?next=%2Fshop%2Fcheckout"
                className="ml-2 underline underline-offset-4"
              >
                登入
              </Link>
            </>
          )}
          {" · "}
          <Link href="/shop/orders" className="underline underline-offset-4">
            我的訂單
          </Link>
        </p>
      ) : null}
      {/* 訂單摘要 */}
      <div className="rounded-[14px] bg-white px-6 py-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]">
        <ul className="space-y-2">
          {items.map((i) => (
            <li key={i.productId} className="flex justify-between gap-3 text-[13.5px]">
              <span className="min-w-0 truncate text-black/70">
                {i.name} × {i.qty}
              </span>
              <span className="shrink-0 tabular-nums text-black/80">
                NT$ {(i.unitPrice * i.qty).toLocaleString("zh-TW")}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3 space-y-1.5 border-t border-black/[0.08] pt-3 text-[13.5px]">
          <div className="flex justify-between">
            <span className="text-black/55">小計</span>
            <span className="tabular-nums text-black/80">
              NT$ {subtotal.toLocaleString("zh-TW")}
            </span>
          </div>
          {promo ? (
            <div className="flex justify-between">
              <span className="text-black/55">
                優惠碼 <span className="font-mono">{promo.code}</span>
              </span>
              <span className="tabular-nums text-emerald-700">
                {promo.discount > 0
                  ? `− NT$ ${promo.discount.toLocaleString("zh-TW")}`
                  : "免運"}
              </span>
            </div>
          ) : null}
          {selectedShip ? (
            <div className="flex justify-between">
              <span className="text-black/55">運費({selectedShip.name})</span>
              <span className="tabular-nums text-black/80">
                {shippingFee === 0 ? "免運" : `NT$ ${shippingFee.toLocaleString("zh-TW")}`}
              </span>
            </div>
          ) : null}
          <div className="flex justify-between pt-1 text-[14.5px]">
            <span className="text-black/55">合計</span>
            <span className="font-semibold tabular-nums text-black/85">
              NT$ {total.toLocaleString("zh-TW")}
            </span>
          </div>
        </div>
      </div>

      <div>
        <label htmlFor="shop-name" className={LABEL}>
          姓名
        </label>
        <input
          id="shop-name"
          className={FIELD}
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor="shop-email" className={LABEL}>
          Email
        </label>
        <input
          id="shop-email"
          className={FIELD}
          type="email"
          required
          maxLength={200}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor="shop-phone" className={LABEL}>
          {options.requireContact ? "電話" : "電話(選填)"}
        </label>
        <input
          id="shop-phone"
          required={options.requireContact}
          type="tel"
          className={FIELD}
          maxLength={30}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
      </div>
      {shippingConfig ? (
        <div>
          <label htmlFor="shop-region" className={LABEL}>
            收件地區
          </label>
          <select
            id="shop-region"
            className={FIELD}
            value={region}
            onChange={(e) => setRegion(e.target.value)}
          >
            <option value="">請選擇</option>
            {TW_REGIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div>
        <label htmlFor="shop-address" className={LABEL}>
          {options.requireContact ? "收件地址" : "收件地址(選填)"}
        </label>
        <input
          id="shop-address"
          required={options.requireContact}
          className={FIELD}
          maxLength={200}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
      </div>

      {/* 配送方式(整排列出,客人挑 —— 每個選項的運費已套完規則) */}
      {shipOptions.length > 0 ? (
        <fieldset>
          <legend className={LABEL}>配送方式</legend>
          <div className="flex flex-col gap-2">
            {shipOptions.map((o) => {
              const active = selectedShip?.id === o.id;
              return (
                <label
                  key={o.id}
                  className={`flex cursor-pointer items-baseline justify-between gap-3 rounded-[10px] px-4 py-3 text-[14px] ${
                    active
                      ? "bg-black text-white"
                      : "bg-white text-black/70 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)]"
                  }`}
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <input
                      type="radio"
                      name="shipping"
                      value={o.id}
                      checked={active}
                      onChange={() => setShipChoice(o.id)}
                      className="sr-only"
                    />
                    <span>{o.name}</span>
                    {o.applied.length > 0 ? (
                      <span
                        className={`truncate text-[11.5px] ${active ? "text-white/60" : "text-black/60"}`}
                      >
                        {o.applied.join("、")}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {o.fee === 0 ? "免運" : `NT$ ${o.fee.toLocaleString("zh-TW")}`}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {/* 優惠碼 */}
      {promoEnabled ? (
        <div>
          <label htmlFor="shop-promo" className={LABEL}>
            優惠碼(選填)
          </label>
          {promo ? (
            <div className="flex h-11 items-center justify-between rounded-[10px] bg-emerald-50 px-3.5 text-[13.5px] text-emerald-800 shadow-[inset_0_0_0_1px_rgba(4,120,87,0.25)]">
              <span>
                <span className="font-mono">{promo.code}</span> 已套用
                {promo.discount > 0
                  ? ` — 折 NT$ ${promo.discount.toLocaleString("zh-TW")}`
                  : " — 免運"}
              </span>
              <button
                type="button"
                className="text-[12.5px] underline underline-offset-2"
                onClick={() => {
                  setPromo(null);
                  setPromoInput("");
                }}
              >
                移除
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                id="shop-promo"
                className={`${FIELD} flex-1 font-mono uppercase`}
                maxLength={40}
                value={promoInput}
                onChange={(e) => {
                  setPromoInput(e.target.value.toUpperCase());
                  setPromoError(null);
                }}
                placeholder="WELCOME10"
              />
              <button
                type="button"
                disabled={busy || promoInput.trim().length < 2}
                onClick={() => void applyPromo()}
                className="h-11 shrink-0 rounded-[10px] px-4 text-[13.5px] text-black/70 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)] hover:bg-black/[0.04] disabled:opacity-40"
              >
                套用
              </button>
            </div>
          )}
          {promoError ? (
            <p className="mt-1.5 text-[12.5px] text-red-700">{promoError}</p>
          ) : null}
        </div>
      ) : null}

      {/* 推薦碼(受管訂單 + referralMode "field";推薦連結帶入的碼已先填好) */}
      {referral === "field" ? (
        <div>
          <label htmlFor="shop-referral" className={LABEL}>
            推薦碼(選填)
          </label>
          <input
            id="shop-referral"
            className={`${FIELD} font-mono uppercase`}
            maxLength={30}
            autoComplete="off"
            value={referralCode}
            onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
          />
        </div>
      ) : null}

      {/* 付款方式 */}
      <fieldset>
        <legend className={LABEL}>付款方式</legend>
        <div className="flex gap-2">
          {cardEnabled ? (
            <label
              className={`flex-1 cursor-pointer rounded-[10px] px-4 py-3 text-center text-[14px] ${
                method === "card"
                  ? "bg-black text-white"
                  : "bg-white text-black/70 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)]"
              }`}
            >
              <input
                type="radio"
                name="method"
                value="card"
                checked={method === "card"}
                onChange={() => setMethod("card")}
                className="sr-only"
              />
              線上刷卡
            </label>
          ) : null}
          {transferEnabled ? (
            <label
              className={`flex-1 cursor-pointer rounded-[10px] px-4 py-3 text-center text-[14px] ${
                method === "transfer"
                  ? "bg-black text-white"
                  : "bg-white text-black/70 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)]"
              }`}
            >
              <input
                type="radio"
                name="method"
                value="transfer"
                checked={method === "transfer"}
                onChange={() => setMethod("transfer")}
                className="sr-only"
              />
              銀行轉帳
            </label>
          ) : null}
        </div>
      </fieldset>

      {error ? <p className="text-[13px] text-red-700">{error}</p> : null}

      <button type="submit" disabled={busy || noMethods} className={PRIMARY_BTN}>
        {busy
          ? "處理中…"
          : method === "card"
            ? "前往付款"
            : "成立訂單,取得匯款帳號"}
      </button>
      {noMethods ? (
        <p className="text-center text-[12.5px] text-black/60">
          目前沒有可用的付款方式(店家尚未設定)。
        </p>
      ) : null}
    </form>
  );
}
