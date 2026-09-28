// 結帳頁的表單樣式(CheckoutView 與結帳完成頁的回報表單共用):中性的黑白 utility,站台的殼會換成自己的色。

export const FIELD =
  "h-11 w-full rounded-[10px] bg-white px-3.5 text-[14px] text-black/85 " +
  "shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)] outline-none " +
  "focus:shadow-[inset_0_0_0_1.5px_rgba(0,0,0,0.6)]";
export const LABEL = "mb-1.5 block text-[12.5px] text-black/55";
/** 訂單編號、帳號這類沒有空白的長代碼:手機上放不下時在任意字元處換行,不撐出卡片。 */
export const CODE = "font-mono [overflow-wrap:anywhere]";
export const PRIMARY_BTN =
  "grid h-11 w-full place-items-center rounded-[12px] bg-black text-[14.5px] " +
  "font-medium text-white hover:bg-black/85 disabled:opacity-50";
