"use client";

import { createContext, useContext } from "react";

// commerce-kit:後台優惠碼表單給「填在表單插槽裡的元件」看的東西(插槽是 core-slots.ts 的 AdminPromoFormFields)。
//
// 填的元件是 client 元件。它用 usePromoForm() 知道表單上現在是哪個代碼、是在建立還是編輯,並用 afterSave 登記
// 「這個代碼存好之後要一起做的事」(例如把代碼記進自己的資料)。欄位的樣子用 PROMO_FIELD / PROMO_LABEL,
// 和表單其他欄位長得一樣。

/** 代碼存好之後要做的事。拿到剛存的代碼;回傳一句話 = 沒做成(表單把這句話顯示出來),null = 好了。 */
export type PromoAfterSave = (code: string) => Promise<string | null>;

export interface PromoFormState {
  /** 表單上的代碼(大寫;還沒填是 "")。 */
  code: string;
  /** true = 在編輯一個已經有的代碼;false = 在建立新的。 */
  editing: boolean;
  /** 表單送出中(填的欄位跟著停用)。 */
  busy: boolean;
  /** 登記存好之後要做的事;回傳取消登記的函式(放進 effect 的 cleanup)。 */
  afterSave(handler: PromoAfterSave): () => void;
}

const PromoFormContext = createContext<PromoFormState | null>(null);

export const PromoFormProvider = PromoFormContext.Provider;

/** 優惠碼表單現在的狀態;不在表單的插槽裡時是 null。 */
export function usePromoForm(): PromoFormState | null {
  return useContext(PromoFormContext);
}

/** 表單輸入框與標籤的樣式(Tailwind 只認得原文寫出來的 class)。 */
export const PROMO_FIELD =
  "h-9 rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] bg-white admin:bg-surface px-2.5 text-[13px] text-black/85 admin:text-ink/85 " +
  "shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)] outline-none " +
  "focus:shadow-[inset_0_0_0_1.5px_rgba(0,0,0,0.6)]";
export const PROMO_LABEL = "mb-1 block text-[12px] text-black/50 admin:text-ink/50";
/** 欄位底下的小字說明。 */
export const PROMO_HINT = "text-[12px] text-black/45 admin:text-ink/45";
