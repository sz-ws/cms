"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
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
};

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
}: {
  cardEnabled: boolean;
  transferEnabled: boolean;
  /** 運費設定(null = 店家未啟用運費,不出現配送選擇)。 */
  shippingConfig?: ShippingConfig | null;
  /** 店家有啟用中的優惠碼才顯示輸入欄。 */
  promoEnabled?: boolean;
}) {
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
      const res = await fetch("/api/ext/shop/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: items.map((i) => ({ productId: i.productId, qty: i.qty })),
          name: name.trim(),
          email: email.trim(),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(address.trim() ? { address: address.trim() } : {}),
          ...(region ? { region } : {}),
          ...(selectedShip ? { shippingMethodId: selectedShip.id } : {}),
          ...(promo ? { promoCode: promo.code } : {}),
          method,
        }),
      });
      const data = (await res.json()) as
        | { ok: true; orderNo: string; session: CheckoutSession }
        | { ok: false; error: string };
      if (!data.ok) {
        setError(ERROR_HINT[data.error] ?? `結帳失敗:${data.error}`);
        return;
      }
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
      const res = await fetch("/api/ext/shop/transfer-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderNo: manual.orderNo, last5 }),
      });
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
            訂單已成立,請於三日內匯款至以下帳戶:
          </p>
          <dl className="mt-4 space-y-2.5">
            {manual.instructions.map((line) => (
              <div key={line.label} className="flex items-baseline gap-3">
                <dt className="w-20 shrink-0 text-[12.5px] text-black/45">
                  {line.label}
                </dt>
                <dd className="font-mono text-[14px] text-black/85">
                  {line.value}
                </dd>
              </div>
            ))}
          </dl>
          {manual.note ? (
            <p className="mt-4 text-[12.5px] leading-relaxed text-black/50">
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
            <p className="text-center text-[12px] text-black/40">
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
      <p className="text-[14px] text-black/50">
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
          電話(選填)
        </label>
        <input
          id="shop-phone"
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
          收件地址(選填)
        </label>
        <input
          id="shop-address"
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
                        className={`truncate text-[11.5px] ${active ? "text-white/60" : "text-black/40"}`}
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
        <p className="text-center text-[12.5px] text-black/45">
          目前沒有可用的付款方式(店家尚未設定)。
        </p>
      ) : null}
    </form>
  );
}
