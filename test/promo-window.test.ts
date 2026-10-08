import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

// 優惠碼的開始與結束(日期 + 時間,照站台時區):
//   1. 表單上的日期、時間 ↔ epoch ms 的換算(promo-window.ts,純函式)。
//   2. 儲存 API 收 startsAt / endsAt,讀回來是同一個值。
//   3. 優惠碼目錄(capability commerce:promos):別的插件問一個代碼現在的樣子,不必知道它存在哪張表。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

import { db } from "../src/lib/db";
import { edgeFromMs, edgeToMs, promoPeriodState } from "../src/ext/commerce-kit/promo-window";
import { createPromoDeleteHandler, createPromoSaveHandler, listPromos, listPromosByCodes, quotePromo } from "../src/ext/commerce-kit/promo";
import { createPromoCatalog, isPromoCatalog } from "../src/ext/commerce-kit/promo-catalog";
import type { ApiCtx } from "../src/ext/types";
import type { CoreServices } from "../src/ext/services";

const TAIPEI = "Asia/Taipei";
const NEW_YORK = "America/New_York";
/** 台北的牆上時間 → epoch ms(台北整年 UTC+8)。 */
const taipei = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0) => Date.UTC(y, m - 1, d, h - 8, min, s, ms);

describe("表單上的日期與時間 → epoch ms", () => {
  it("treats an empty date as no bound", () => {
    expect(edgeToMs("start", { day: "", time: "" }, TAIPEI)).toEqual({ ok: true, at: null });
    expect(edgeToMs("end", { day: "", time: "" }, TAIPEI)).toEqual({ ok: true, at: null });
  });
  it("reads a date alone as the start of that day, or the last moment of that day", () => {
    expect(edgeToMs("start", { day: "2026-10-31", time: "" }, TAIPEI)).toEqual({ ok: true, at: taipei(2026, 10, 31) });
    expect(edgeToMs("end", { day: "2026-10-31", time: "" }, TAIPEI)).toEqual({ ok: true, at: taipei(2026, 11, 1) - 1 });
  });
  it("reads a date with a time of day as that minute", () => {
    expect(edgeToMs("start", { day: "2026-10-31", time: "09:30" }, TAIPEI)).toEqual({ ok: true, at: taipei(2026, 10, 31, 9, 30) });
    expect(edgeToMs("end", { day: "2026-10-31", time: "18:00" }, TAIPEI)).toEqual({ ok: true, at: taipei(2026, 10, 31, 18) });
    expect(edgeToMs("end", { day: "2026-10-31", time: "00:00" }, TAIPEI)).toEqual({ ok: true, at: taipei(2026, 10, 31) });
  });
  it("uses the site's time zone, including a day that is 25 hours long", () => {
    // 紐約 2026-11-01 是夏令時間結束的那一天。
    const start = edgeToMs("start", { day: "2026-11-01", time: "" }, NEW_YORK);
    const end = edgeToMs("end", { day: "2026-11-01", time: "" }, NEW_YORK);
    expect(start).toEqual({ ok: true, at: Date.UTC(2026, 10, 1, 4) });
    expect(end).toEqual({ ok: true, at: Date.UTC(2026, 10, 2, 5) - 1 });
  });
  it("refuses a time without a date, and dates or times that do not exist", () => {
    expect(edgeToMs("start", { day: "", time: "09:00" }, TAIPEI)).toEqual({ ok: false, reason: "day_missing" });
    for (const day of ["2026-02-31", "2026-13-01", "20261031", "abc"]) expect(edgeToMs("end", { day, time: "" }, TAIPEI)).toEqual({ ok: false, reason: "invalid" });
    for (const time of ["24:00", "9:00", "09:60", "noon"]) expect(edgeToMs("end", { day: "2026-10-31", time }, TAIPEI)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("epoch ms → 表單上的日期與時間", () => {
  it("round-trips, leaving the time blank for the start of a day and for the end of a day", () => {
    expect(edgeFromMs("start", null, TAIPEI)).toEqual({ day: "", time: "" });
    expect(edgeFromMs("start", taipei(2026, 10, 31), TAIPEI)).toEqual({ day: "2026-10-31", time: "" });
    expect(edgeFromMs("end", taipei(2026, 11, 1) - 1, TAIPEI)).toEqual({ day: "2026-10-31", time: "" });
    expect(edgeFromMs("start", taipei(2026, 10, 31, 9, 30), TAIPEI)).toEqual({ day: "2026-10-31", time: "09:30" });
    expect(edgeFromMs("end", taipei(2026, 10, 31, 18), TAIPEI)).toEqual({ day: "2026-10-31", time: "18:00" });
    // 結束剛好是 00:00:那是那一天的第一刻,不是「當天結束」。
    expect(edgeFromMs("end", taipei(2026, 10, 31), TAIPEI)).toEqual({ day: "2026-10-31", time: "00:00" });
    // 表單讀出來再存回去,值不變。23:59 的結束時間還是 23:59 那一分鐘,不會變成當天結束。
    const cases: ["start" | "end", number][] = [
      ["start", taipei(2026, 10, 31)], ["start", taipei(2026, 10, 31, 9, 30)], ["start", taipei(2026, 12, 31, 23, 59)],
      ["end", taipei(2026, 11, 1) - 1], ["end", taipei(2026, 10, 31, 18)], ["end", taipei(2026, 12, 31, 23, 59)], ["end", taipei(2026, 10, 31)],
    ];
    for (const [edge, at] of cases) expect(edgeToMs(edge, edgeFromMs(edge, at, TAIPEI), TAIPEI)).toEqual({ ok: true, at });
  });
});

describe("這個優惠碼現在用不用得了", () => {
  const base = { enabled: true, startsAt: null as number | null, endsAt: null as number | null, used: 0, maxUses: null as number | null };
  it("tells active, disabled, not started, expired and used up apart", () => {
    const now = taipei(2026, 10, 8, 12);
    expect(promoPeriodState(base, now)).toBe("active");
    expect(promoPeriodState({ ...base, enabled: false, endsAt: now - 1 }, now)).toBe("disabled");
    expect(promoPeriodState({ ...base, startsAt: now + 1 }, now)).toBe("scheduled");
    expect(promoPeriodState({ ...base, startsAt: now }, now)).toBe("active");
    expect(promoPeriodState({ ...base, endsAt: now - 1 }, now)).toBe("expired");
    expect(promoPeriodState({ ...base, endsAt: now }, now)).toBe("active");
    expect(promoPeriodState({ ...base, maxUses: 3, used: 3 }, now)).toBe("used_up");
    expect(promoPeriodState({ ...base, maxUses: 3, used: 2 }, now)).toBe("active");
  });
});

// ---- 以下需要 DB ----

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;
const TABLE = "ext_pwtest_promos";
const ctx = () => ({ user: { id: "admin", email: "a@test", name: "a", role: "admin", avatarKey: null }, services: { db: db() } as unknown as CoreServices }) as ApiCtx;
const save = createPromoSaveHandler({ table: TABLE });
const remove = createPromoDeleteHandler({ table: TABLE });
const post = (body: unknown) => new Request("https://cms.test/api/ext/shop/promos/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const saved = async (body: Record<string, unknown>) => { const res = await save(post(body), {}, ctx()); return { status: res.status, body: (await res.json()) as Record<string, unknown> }; };
const BASE = { code: "SAVE10", label: "", type: "percent", value: 10, minSubtotal: 0, maxUses: null, enabled: true };

beforeAll(async () => {
  await d1().exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (code TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0, min_subtotal INTEGER NOT NULL DEFAULT 0, max_uses INTEGER, used INTEGER NOT NULL DEFAULT 0, starts_at INTEGER, ends_at INTEGER, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
});
beforeEach(async () => { await d1().exec(`DELETE FROM ${TABLE};`); });

describe("儲存 API 的開始與結束", () => {
  it("stores both and reads them back unchanged", async () => {
    const startsAt = taipei(2026, 10, 1, 9, 30); const endsAt = taipei(2026, 11, 1) - 1;
    expect(await saved({ ...BASE, startsAt, endsAt })).toEqual({ status: 200, body: { ok: true, code: "SAVE10" } });
    const [promo] = await listPromos({ db: db() }, TABLE);
    expect(promo).toMatchObject({ code: "SAVE10", startsAt, endsAt, used: 0 });
    // 結帳照這兩個時間擋。
    expect(await quotePromo({ db: db() }, TABLE, "SAVE10", 100, startsAt - 1)).toMatchObject({ ok: false, reason: "not_started" });
    expect(await quotePromo({ db: db() }, TABLE, "SAVE10", 100, startsAt)).toMatchObject({ ok: true });
    expect(await quotePromo({ db: db() }, TABLE, "SAVE10", 100, endsAt)).toMatchObject({ ok: true });
    expect(await quotePromo({ db: db() }, TABLE, "SAVE10", 100, endsAt + 1)).toMatchObject({ ok: false, reason: "expired" });
  });
  it("changes one end, and clears an end that is sent as null", async () => {
    const startsAt = taipei(2026, 10, 1); const endsAt = taipei(2026, 10, 31, 18);
    await saved({ ...BASE, startsAt, endsAt });
    await saved({ ...BASE, startsAt, endsAt: null });
    expect((await listPromos({ db: db() }, TABLE))[0]).toMatchObject({ startsAt, endsAt: null });
    await saved({ ...BASE, startsAt: null, endsAt });
    expect((await listPromos({ db: db() }, TABLE))[0]).toMatchObject({ startsAt: null, endsAt });
    await saved({ ...BASE, startsAt: null, endsAt: null });
    expect((await listPromos({ db: db() }, TABLE))[0]).toMatchObject({ startsAt: null, endsAt: null });
  });
  it("keeps the stored start and end when a save leaves them out", async () => {
    // 部署前就開著的後台分頁、腳本、AI 連線都不會送這兩個欄位:沒送 = 不動,不是清掉。
    const startsAt = taipei(2026, 10, 1); const endsAt = taipei(2026, 10, 31, 18);
    await saved({ ...BASE, startsAt, endsAt });
    expect(await saved({ ...BASE, label: "十月", value: 15 })).toEqual({ status: 200, body: { ok: true, code: "SAVE10" } });
    expect((await listPromos({ db: db() }, TABLE))[0]).toMatchObject({ label: "十月", value: 15, startsAt, endsAt });
    // 只送一端:另一端照舊。
    const later = taipei(2026, 10, 15);
    await saved({ ...BASE, startsAt: later });
    expect((await listPromos({ db: db() }, TABLE))[0]).toMatchObject({ startsAt: later, endsAt });
    await saved({ ...BASE, endsAt: null });
    expect((await listPromos({ db: db() }, TABLE))[0]).toMatchObject({ startsAt: later, endsAt: null });
    // 新的代碼沒送就是不限。
    await saved({ ...BASE, code: "NEW" });
    expect((await listPromos({ db: db() }, TABLE)).find((p) => p.code === "NEW")).toMatchObject({ startsAt: null, endsAt: null });
  });
  it("keeps the time a code was created when it is saved again", async () => {
    // 建立時間認的是「這一個碼」:別的插件靠它分得出同名的碼是不是刪掉重建的。編輯不能動它。
    await d1().prepare(`INSERT INTO ${TABLE} (code, type, value, created_at, updated_at) VALUES ('SAVE10', 'percent', 10, 5, 5)`).run();
    await saved({ ...BASE, value: 15 });
    const [edited] = await listPromos({ db: db() }, TABLE);
    expect(edited).toMatchObject({ value: 15, createdAt: 5 });
    expect(edited.updatedAt).toBeGreaterThan(5);
    await remove(post({ code: "SAVE10" }), {}, ctx());
    await saved(BASE);
    expect((await listPromos({ db: db() }, TABLE))[0].createdAt).toBeGreaterThan(5);
  });
  it("refuses one end that would not fit the end that is kept", async () => {
    const startsAt = taipei(2026, 10, 1); const endsAt = taipei(2026, 10, 31, 18);
    await saved({ ...BASE, startsAt, endsAt });
    expect((await saved({ ...BASE, label: "改過", startsAt: endsAt })).status).toBe(400);
    expect((await saved({ ...BASE, label: "改過", endsAt: startsAt })).status).toBe(400);
    expect((await listPromos({ db: db() }, TABLE))[0]).toMatchObject({ label: "", startsAt, endsAt });
  });
  it("refuses an end that is not after the start, and values that are not whole milliseconds", async () => {
    const at = taipei(2026, 10, 1);
    expect((await saved({ ...BASE, startsAt: at, endsAt: at })).status).toBe(400);
    expect((await saved({ ...BASE, startsAt: at, endsAt: at - 1 })).status).toBe(400);
    expect((await saved({ ...BASE, startsAt: "2026-10-01" })).status).toBe(400);
    expect((await saved({ ...BASE, endsAt: 1.5 })).status).toBe(400);
    expect((await saved({ ...BASE, endsAt: -1 })).status).toBe(400);
    expect(await listPromos({ db: db() }, TABLE)).toEqual([]);
  });
});

describe("優惠碼目錄(commerce:promos)", () => {
  it("answers what the asked codes look like now, and leaves out the ones that do not exist", async () => {
    const endsAt = taipei(2026, 10, 31, 18);
    await saved({ ...BASE, endsAt });
    await saved({ ...BASE, code: "SHIP", type: "freeship", value: 0, enabled: false });
    const catalog = createPromoCatalog({ db: db() }, TABLE, { adminHref: "/admin/ext/demo/promos" });
    expect(isPromoCatalog(catalog)).toBe(true);
    expect(catalog.adminHref).toBe("/admin/ext/demo/promos");
    const found = await catalog.byCodes(["SHIP", "GONE", "save10", "SAVE10"]);
    expect(found.map((p) => p.code).sort()).toEqual(["SAVE10", "SHIP"]);
    expect(found.find((p) => p.code === "SAVE10")).toMatchObject({ type: "percent", value: 10, used: 0, maxUses: null, enabled: true, endsAt });
    expect(found.find((p) => p.code === "SHIP")).toMatchObject({ type: "freeship", enabled: false });
    expect(await catalog.byCodes([])).toEqual([]);
    await remove(post({ code: "SHIP" }), {}, ctx());
    expect((await catalog.byCodes(["SHIP", "SAVE10"])).map((p) => p.code)).toEqual(["SAVE10"]);
  });
  it("asks for more codes than one query can bind, and reads an unmade table as empty", async () => {
    await saved(BASE);
    const many = [...Array.from({ length: 300 }, (_, i) => `NONE${i}`), "SAVE10"];
    expect((await createPromoCatalog({ db: db() }, TABLE).byCodes(many)).map((p) => p.code)).toEqual(["SAVE10"]);
    expect(await createPromoCatalog({ db: db() }, "ext_pwtest_missing").byCodes(["SAVE10"])).toEqual([]);
    expect(createPromoCatalog({ db: db() }, TABLE).adminHref).toBeNull();
    expect([isPromoCatalog(null), isPromoCatalog({}), isPromoCatalog({ byCodes: 1 })]).toEqual([false, false, false]);
  });
  it("reads only an unmade table as empty: any other database error reaches the asker", async () => {
    // 資料庫一時連不上不是「沒有這個碼」:吞掉的話,問的一方會照「這個碼不存在」去回話、去做事。
    const failing = (error: Error) => ({ db: { all: async () => { throw error; } } }) as unknown as Parameters<typeof listPromosByCodes>[0];
    const lost = new Error("D1_ERROR: Network connection lost.");
    await expect(listPromosByCodes(failing(lost), TABLE, ["SAVE10"])).rejects.toBe(lost);
    await expect(createPromoCatalog(failing(lost), TABLE).byCodes(["SAVE10"])).rejects.toBe(lost);
    // 少的是別張表、或少一個欄位:也不是「表還沒建」。
    await expect(listPromosByCodes(failing(new Error("D1_ERROR: no such table: ext_other: SQLITE_ERROR")), TABLE, ["SAVE10"])).rejects.toThrow("ext_other");
    await expect(listPromosByCodes(failing(new Error("D1_ERROR: no such column: starts_at: SQLITE_ERROR")), TABLE, ["SAVE10"])).rejects.toThrow("no such column");
    // 表還沒建:D1 的錯誤直接丟出來、或包在另一個錯誤的 cause 裡,都是空的。
    const missing = new Error(`D1_ERROR: no such table: ${TABLE}: SQLITE_ERROR`);
    expect(await listPromosByCodes(failing(missing), TABLE, ["SAVE10"])).toEqual([]);
    expect(await listPromosByCodes(failing(new Error("Failed query: select …", { cause: missing })), TABLE, ["SAVE10"])).toEqual([]);
    // 沒有要問的代碼就不查,什麼錯都碰不到。
    expect(await listPromosByCodes(failing(lost), TABLE, [])).toEqual([]);
  });
});
