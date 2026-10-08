import type { Promo, PromoType } from "./promo";
import { normalizePromoCode } from "./promo-code";
import { edgeFromMs, edgeToMs, type PromoEdge, type PromoEdgeValue } from "./promo-window";

// commerce-kit:後台優惠碼表單的資料(PromosAdmin.tsx 畫,這裡只管資料;沒有 React)。
// 表單上的值 ↔ 儲存 API 的 body(promo.ts 的 createPromoSaveHandler)。開始與結束在表單上是日期與時間兩格,
// 照站台時區換成 epoch ms(promo-window.ts)。

export interface PromoFormValues {
  code: string;
  label: string;
  type: PromoType;
  value: number;
  minSubtotal: number;
  maxUses: number | null;
  enabled: boolean;
  /** 開始:日期 `YYYY-MM-DD` 與時間 `HH:MM`,都可以空白。 */
  startDay: string;
  startTime: string;
  /** 結束:同上。 */
  endDay: string;
  endTime: string;
}

export const EMPTY_PROMO_FORM: PromoFormValues = {
  code: "",
  label: "",
  type: "percent",
  value: 10,
  minSubtotal: 0,
  maxUses: null,
  enabled: true,
  startDay: "",
  startTime: "",
  endDay: "",
  endTime: "",
};

/** POST promos/save 的 body。 */
export interface PromoSaveBody {
  code: string;
  label: string;
  type: PromoType;
  value: number;
  minSubtotal: number;
  maxUses: number | null;
  enabled: boolean;
  startsAt: number | null;
  endsAt: number | null;
}

/** 一筆優惠碼 → 表單(按「編輯」時)。 */
export function promoToForm(promo: Promo, timeZone: string): PromoFormValues {
  const start = edgeFromMs("start", promo.startsAt, timeZone);
  const end = edgeFromMs("end", promo.endsAt, timeZone);
  return {
    code: promo.code,
    label: promo.label,
    type: promo.type,
    value: promo.value,
    minSubtotal: promo.minSubtotal,
    maxUses: promo.maxUses,
    enabled: promo.enabled,
    startDay: start.day,
    startTime: start.time,
    endDay: end.day,
    endTime: end.time,
  };
}

const EDGE_NAME: Record<PromoEdge, string> = { start: "開始", end: "結束" };

function edgeProblem(edge: PromoEdge, value: PromoEdgeValue): string | null {
  if (value.ok) return null;
  return value.reason === "day_missing"
    ? `請先選${EDGE_NAME[edge]}日期。`
    : `${EDGE_NAME[edge]}的日期要像 2026-10-31，時間要像 09:30，請重新填。`;
}

/** 表單 → 要送出的 body;期間填得不對時回一句給店家看的話,什麼都不送。 */
export function formToBody(
  form: PromoFormValues,
  timeZone: string,
): { ok: true; body: PromoSaveBody } | { ok: false; message: string } {
  const start = edgeToMs("start", { day: form.startDay, time: form.startTime }, timeZone);
  const end = edgeToMs("end", { day: form.endDay, time: form.endTime }, timeZone);
  const problem = edgeProblem("start", start) ?? edgeProblem("end", end);
  if (problem || !start.ok || !end.ok) return { ok: false, message: problem ?? "" };
  if (start.at !== null && end.at !== null && end.at <= start.at) {
    return { ok: false, message: "結束時間要晚於開始時間。" };
  }
  return {
    ok: true,
    body: {
      code: normalizePromoCode(form.code),
      label: form.label,
      type: form.type,
      value: form.value,
      minSubtotal: form.minSubtotal,
      maxUses: form.maxUses,
      enabled: form.enabled,
      startsAt: start.at,
      endsAt: end.at,
    },
  };
}
