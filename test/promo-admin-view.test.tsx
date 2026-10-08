import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 後台優惠碼頁(commerce-kit PromosAdmin):
//   1. 表單多了開始與結束(日期 + 時間,照站台時區);表單 ↔ 儲存 API 的內容來回不走樣(promo-form-state.ts)。
//   2. 列表寫出期間,狀態分得出還沒開始、過期、用完。
//   3. 表單裡有一個插槽(AdminPromoFormFields):別的插件填的欄位畫在表單裡,並拿得到表單上的代碼(usePromoForm)。
// 這裡畫的是第一眼的樣子(server render);按「編輯」把資料帶進表單、存檔後跑插槽登記的動作,要在瀏覽器裡看。

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

import { PromosAdmin } from "../src/ext/commerce-kit/PromosAdmin";
import { EMPTY_PROMO_FORM, formToBody, promoToForm } from "../src/ext/commerce-kit/promo-form-state";
import { usePromoForm } from "../src/ext/commerce-kit/promo-form";
import { AdminPromoFormFields } from "../src/ext/core-slots";
import type { Promo } from "../src/ext/commerce-kit/promo";
import type { SlotParts } from "../src/ext/slots";

// 畫面沒有包 DateTimeProvider 時,站台時區是預設的台北(lib/datetime.ts 的 DEFAULT_TIME_ZONE)。
const TAIPEI = "Asia/Taipei";
const taipei = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 8, min);
const NOW = taipei(2026, 10, 8, 12);
const promo = (over: Partial<Promo>): Promo => ({ code: "SAVE10", label: "", type: "percent", value: 10, minSubtotal: 0, maxUses: null, used: 0, startsAt: null, endsAt: null, enabled: true, createdAt: 1, updatedAt: 1, ...over });
const render = (props: Partial<Parameters<typeof PromosAdmin>[0]>) =>
  renderToStaticMarkup(createElement(PromosAdmin, { endpoint: "/api/ext/shop", promos: [], ...props }));
const input = (html: string, label: string) => html.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";
const row = (html: string, code: string) => html.match(new RegExp(`<tr[^>]*>(?:(?!</tr>).)*>${code}<.*?</tr>`, "s"))?.[0] ?? "";

describe("表單的開始與結束", () => {
  it("has a date and a time of day for each end, and says what a date alone means", () => {
    const html = render({});
    expect(input(html, "開始日期")).toContain('type="date"');
    expect(input(html, "開始時間")).toContain('type="time"');
    expect(input(html, "結束日期")).toContain('type="date"');
    expect(input(html, "結束時間")).toContain('type="time"');
    expect(html).toContain("開始（空白 = 不限）");
    expect(html).toContain("結束（空白 = 不限）");
    expect(html).toContain("只選日期時，開始從當天 00:00 算，結束算到當天 23:59。時間是網站的時區：台北（UTC+8）。");
    // 只能看的角色沒有表單。
    expect(render({ readOnly: true })).not.toContain("開始日期");
  });
  it("turns the form into the body the save API takes, in the site's time zone", () => {
    const form = { ...EMPTY_PROMO_FORM, code: " save10 ", startDay: "2026-10-01", startTime: "09:30", endDay: "2026-10-31", endTime: "" };
    expect(formToBody(form, TAIPEI)).toEqual({ ok: true, body: { code: "SAVE10", label: "", type: "percent", value: 10, minSubtotal: 0, maxUses: null, enabled: true, startsAt: taipei(2026, 10, 1, 9, 30), endsAt: taipei(2026, 11, 1) - 1 } });
    expect(formToBody({ ...EMPTY_PROMO_FORM, code: "A1" }, TAIPEI)).toMatchObject({ ok: true, body: { startsAt: null, endsAt: null } });
    // 同一組字在別的時區是別的瞬間。
    expect(formToBody({ ...form, endDay: "" }, "UTC")).toMatchObject({ ok: true, body: { startsAt: Date.UTC(2026, 9, 1, 9, 30), endsAt: null } });
  });
  it("says in plain words what is wrong with the period before anything is sent", () => {
    const base = { ...EMPTY_PROMO_FORM, code: "SAVE10" };
    expect(formToBody({ ...base, startTime: "09:00" }, TAIPEI)).toEqual({ ok: false, message: "請先選開始日期。" });
    expect(formToBody({ ...base, endTime: "09:00" }, TAIPEI)).toEqual({ ok: false, message: "請先選結束日期。" });
    expect(formToBody({ ...base, startDay: "2026-02-31" }, TAIPEI)).toEqual({ ok: false, message: "開始的日期要像 2026-10-31，時間要像 09:30，請重新填。" });
    expect(formToBody({ ...base, endDay: "2026-10-31", endTime: "25:00" }, TAIPEI)).toEqual({ ok: false, message: "結束的日期要像 2026-10-31，時間要像 09:30，請重新填。" });
    expect(formToBody({ ...base, startDay: "2026-10-31", endDay: "2026-10-31", endTime: "00:00" }, TAIPEI)).toEqual({ ok: false, message: "結束時間要晚於開始時間。" });
    expect(formToBody({ ...base, startDay: "2026-10-31", endDay: "2026-10-30" }, TAIPEI)).toEqual({ ok: false, message: "結束時間要晚於開始時間。" });
    // 同一天開始、同一天結束是可以的(00:00 到當天最後一刻)。
    expect(formToBody({ ...base, startDay: "2026-10-31", endDay: "2026-10-31" }, TAIPEI)).toMatchObject({ ok: true });
  });
  it("loads a stored promo into the form and saves it back without moving either end", () => {
    const cases = [
      promo({ startsAt: taipei(2026, 10, 1), endsAt: taipei(2026, 11, 1) - 1 }),
      promo({ startsAt: taipei(2026, 10, 1, 9, 30), endsAt: taipei(2026, 10, 31, 18), maxUses: 50, minSubtotal: 500, label: "十月", enabled: false }),
      promo({ type: "freeship", value: 0 }),
    ];
    for (const stored of cases) {
      const form = promoToForm(stored, TAIPEI);
      expect(formToBody(form, TAIPEI)).toEqual({ ok: true, body: { code: stored.code, label: stored.label, type: stored.type, value: stored.value, minSubtotal: stored.minSubtotal, maxUses: stored.maxUses, enabled: stored.enabled, startsAt: stored.startsAt, endsAt: stored.endsAt } });
    }
    expect(promoToForm(cases[0], TAIPEI)).toMatchObject({ startDay: "2026-10-01", startTime: "", endDay: "2026-10-31", endTime: "" });
    expect(promoToForm(cases[1], TAIPEI)).toMatchObject({ startDay: "2026-10-01", startTime: "09:30", endDay: "2026-10-31", endTime: "18:00" });
  });
});

describe("列表", () => {
  it("writes the period in the site's time zone", () => {
    const html = render({ now: NOW, promos: [
      promo({ code: "OPEN" }),
      promo({ code: "UNTIL", endsAt: taipei(2026, 10, 31, 18) }),
      promo({ code: "FROM", startsAt: taipei(2026, 10, 1) }),
      promo({ code: "BOTH", startsAt: taipei(2026, 10, 1, 9, 30), endsAt: taipei(2026, 11, 1) - 1 }),
    ] });
    expect(html).toContain(">期間</th>");
    expect(row(html, "UNTIL")).toContain("到 2026/10/31 18:00");
    expect(row(html, "FROM")).toContain("2026/10/1 00:00 起");
    expect(row(html, "BOTH")).toContain("2026/10/1 09:30 – 2026/10/31 23:59");
    expect(row(html, "OPEN")).not.toContain("2026/");
  });
  it("tells apart a code that is on, off, not started, expired and used up", () => {
    const html = render({ now: NOW, promos: [
      promo({ code: "ON" }),
      promo({ code: "OFF", enabled: false, endsAt: NOW - 1 }),
      promo({ code: "LATER", startsAt: NOW + 1 }),
      promo({ code: "OLD", endsAt: NOW - 1 }),
      promo({ code: "GONE", maxUses: 3, used: 3 }),
    ] });
    expect(row(html, "ON")).toContain("啟用中");
    expect(row(html, "OFF")).toContain("停用");
    expect(row(html, "LATER")).toContain("尚未開始");
    expect(row(html, "OLD")).toContain("已過期");
    expect(row(html, "GONE")).toContain("已用完");
    // 沒有給現在的時間(舊的呼叫端)就照啟用與否寫。
    expect(row(render({ promos: [promo({ code: "OLD", endsAt: NOW - 1 })] }), "OLD")).toContain("啟用中");
  });
});

describe("表單裡的插槽", () => {
  /** 一個填在插槽裡的欄位:把它從表單拿到的東西寫出來。 */
  function Probe() {
    const form = usePromoForm();
    return createElement("span", { "data-probe": "" }, form ? `code=${form.code || "(空)"};editing=${form.editing};busy=${form.busy};afterSave=${typeof form.afterSave}` : "不在表單裡");
  }
  const parts = (after: ReactNode): SlotParts => ({ slot: AdminPromoFormFields.id, before: null, after, replace: null, wrap: [], props: {} });

  it("is a core slot named for the admin promo form", () => {
    expect(AdminPromoFormFields).toMatchObject({ kind: "view", id: "admin.promo-form.fields" });
  });
  it("draws what plugins put there inside the form, and tells them the code on the form", () => {
    const html = render({ formFields: parts(createElement(Probe)) });
    expect(html).toContain("code=(空);editing=false;busy=false;afterSave=function");
    // 在「啟用」前面:是表單的一格,不是表單外面的東西。
    expect(html.indexOf("data-probe")).toBeGreaterThan(html.indexOf("次數上限"));
    expect(html.indexOf("data-probe")).toBeLessThan(html.indexOf("啟用</label>"));
    expect(render({ readOnly: true, formFields: parts(createElement(Probe)) })).not.toContain("data-probe");
    expect(render({})).not.toContain("data-probe");
    expect(renderToStaticMarkup(createElement(Probe))).toContain("不在表單裡");
  });
});
