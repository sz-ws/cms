import { wallClock, zonedTimeToMs } from "@/lib/datetime";
import type { Promo } from "./promo";

// commerce-kit:優惠碼的開始與結束(starts_at / ends_at,epoch ms)。後台表單上每一端是「日期 + 時間」兩格,
// 照站台時區(core.timeZone)填與顯示。這個檔只做換算與判斷,沒有 React,伺服器與瀏覽器都能用:
//
//   日期空白          → 沒有這一端(null = 不限)。
//   只填日期          → 開始:當天 00:00;結束:當天的最後一刻(隔天 00:00 的前一毫秒)。
//   日期 + 時間       → 那一分鐘的開頭(結束填 18:00 = 18:00 整到期)。
//
// 讀回表單時反過來:開始剛好是當天 00:00、結束剛好是當天最後一刻,時間那一格就空著。

export type PromoEdge = "start" | "end";

/** 表單上的一端:日期 `YYYY-MM-DD`(可空白)與時間 `HH:MM`(可空白)。 */
export interface PromoEdgeInput {
  day: string;
  time: string;
}

export type PromoEdgeValue =
  | { ok: true; at: number | null }
  /** day_missing:填了時間沒填日期;invalid:日期或時間的格式不對、或沒有這一天。 */
  | { ok: false; reason: "day_missing" | "invalid" };

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const pad = (n: number) => String(n).padStart(2, "0");

/** 表單上的一端 → epoch ms(站台時區)。 */
export function edgeToMs(edge: PromoEdge, input: PromoEdgeInput, timeZone: string): PromoEdgeValue {
  const day = input.day.trim();
  const time = input.time.trim();
  if (!day) return time ? { ok: false, reason: "day_missing" } : { ok: true, at: null };
  const d = DAY_RE.exec(day);
  const t = time ? TIME_RE.exec(time) : null;
  if (!d || (time && !t)) return { ok: false, reason: "invalid" };
  const date = { year: Number(d[1]), month: Number(d[2]), day: Number(d[3]) };
  const dayStart = zonedTimeToMs(date, timeZone);
  // 2026-02-31 這種不存在的日期會滾到下個月:換回牆上時間對不上就擋掉。
  const wall = wallClock(dayStart, timeZone);
  if (wall.year !== date.year || wall.month !== date.month || wall.day !== date.day) return { ok: false, reason: "invalid" };
  if (t) return { ok: true, at: zonedTimeToMs({ ...date, hour: Number(t[1]), minute: Number(t[2]) }, timeZone) };
  return { ok: true, at: edge === "start" ? dayStart : zonedTimeToMs({ ...date, day: date.day + 1 }, timeZone) - 1 };
}

/** epoch ms → 表單上的一端(站台時區)。 */
export function edgeFromMs(edge: PromoEdge, at: number | null, timeZone: string): PromoEdgeInput {
  if (at === null) return { day: "", time: "" };
  const wall = wallClock(at, timeZone);
  const day = `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
  const whole = edgeToMs(edge, { day, time: "" }, timeZone);
  // 就是「只填日期」會得到的那個值 → 時間空著。
  if (whole.ok && whole.at === at) return { day, time: "" };
  return { day, time: `${pad(wall.hour)}:${pad(wall.minute)}` };
}

/**
 * 這個優惠碼現在的狀態(後台列表與別的插件顯示用;結帳的檢查在 promo.ts 的 quotePromo / redeemPromo)。
 * 停用優先:店家關掉的碼不管期限都是 disabled。
 */
export type PromoPeriodState = "active" | "disabled" | "scheduled" | "expired" | "used_up";

export function promoPeriodState(
  promo: Pick<Promo, "enabled" | "startsAt" | "endsAt" | "used" | "maxUses">,
  now: number,
): PromoPeriodState {
  if (!promo.enabled) return "disabled";
  if (promo.endsAt !== null && now > promo.endsAt) return "expired";
  if (promo.maxUses !== null && promo.used >= promo.maxUses) return "used_up";
  if (promo.startsAt !== null && now < promo.startsAt) return "scheduled";
  return "active";
}
