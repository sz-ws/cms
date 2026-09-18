import { describe, it, expect } from "vitest";
import {
  createDateFormatter,
  DEFAULT_TIME_ZONE,
  isTimeZone,
  normalizeTimeZone,
  TIME_ZONE_OPTIONS,
  timeZoneOffsetMs,
  zonedTimeToMs,
} from "../src/lib/datetime";
import { fmtDate } from "../src/ext/dx/views/field-utils";
import { dayInputToMs, msToDayInput } from "../src/ext/record-search";
import { relativeTimeWords } from "../src/lib/relative-time";

// 1.41.0:日期 adapter(lib/datetime.ts)。測試跑在 workerd(UTC),跟正式環境一樣 ——
// 以前直接 toLocaleString 會畫出 UTC,這裡確認一律照站台時區。

const TAIPEI = "Asia/Taipei";
const NY = "America/New_York";
// 台北 2026-09-18 00:05 = UTC 2026-09-17 16:05
const JUST_AFTER_MIDNIGHT = Date.UTC(2026, 8, 17, 16, 5);

describe("createDateFormatter", () => {
  const zh = createDateFormatter("zh-Hant", TAIPEI);

  it("用站台時區,不是執行環境的 UTC", () => {
    expect(zh.dateTime(JUST_AFTER_MIDNIGHT)).toBe("2026/9/18 00:05");
    expect(zh.date(JUST_AFTER_MIDNIGHT)).toBe("2026/9/18");
    expect(zh.time(JUST_AFTER_MIDNIGHT)).toBe("00:05");
    expect(zh.monthDay(JUST_AFTER_MIDNIGHT)).toBe("9/18");
    expect(zh.stamp(JUST_AFTER_MIDNIGHT)).toBe("2026-09-18 00:05:00");
    expect(zh.dayKey(JUST_AFTER_MIDNIGHT)).toBe("2026-09-18");
    expect(createDateFormatter("zh-Hant", "UTC").dayKey(JUST_AFTER_MIDNIGHT)).toBe("2026-09-17");
  });

  it("format 的自訂選項也固定站台時區", () => {
    expect(zh.format(JUST_AFTER_MIDNIGHT, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" })).toBe("00:05");
  });

  it("dayStart:站台時區那天的 00:00;end 是隔天 00:00;不存在的日期回 undefined", () => {
    expect(zh.dayStart("2026-09-18")).toBe(Date.UTC(2026, 8, 17, 16));
    expect(zh.dayStart("2026-09-18", true)).toBe(Date.UTC(2026, 8, 18, 16));
    expect(zh.dayStart("2026-02-31")).toBeUndefined();
    expect(zh.dayStart("9/18")).toBeUndefined();
  });

  it("夏令時間:一天不一定是 24 小時,00:00 跟著當天的 offset", () => {
    const ny = createDateFormatter("en", NY);
    expect(ny.dayStart("2026-03-08")).toBe(Date.UTC(2026, 2, 8, 5)); // EST
    expect(ny.dayStart("2026-03-09")).toBe(Date.UTC(2026, 2, 9, 4)); // EDT
    expect(ny.dayStart("2026-03-08", true)! - ny.dayStart("2026-03-08")!).toBe(23 * 3600_000);
    expect(timeZoneOffsetMs(Date.UTC(2026, 6, 1), NY)).toBe(-4 * 3600_000);
    // 11/1 01:30 出現兩次,取第一次(EDT)
    expect(zonedTimeToMs({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY)).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });

  it("壞的時區退回預設(台北)", () => {
    expect(isTimeZone("Mars/Base")).toBe(false);
    expect(normalizeTimeZone("Mars/Base")).toBe(DEFAULT_TIME_ZONE);
    expect(createDateFormatter("en", "nope").timeZone).toBe(DEFAULT_TIME_ZONE);
    for (const option of TIME_ZONE_OPTIONS) expect(isTimeZone(option.value)).toBe(true);
  });

  it("非數字回空字串", () => {
    expect(zh.dateTime(Number.NaN)).toBe("");
    expect(zh.stamp(Number.NaN)).toBe("");
  });
});

describe("用到 adapter 的地方", () => {
  it("date 欄位:台灣挑的 9/18(存成台北 00:00)不再顯示成 9/17", () => {
    const pickedInTaipei = Date.UTC(2026, 8, 17, 16);
    expect(fmtDate(pickedInTaipei, TAIPEI)).toBe("2026-09-18");
    expect(fmtDate(pickedInTaipei)).toBe("2026-09-18");
    expect(fmtDate("not a date")).toBe("");
  });

  it("搜尋的期間以站台時區的一整天為單位", () => {
    expect(dayInputToMs("2026-09-18", false, TAIPEI)).toBe(Date.UTC(2026, 8, 17, 16));
    expect(dayInputToMs("2026-09-18", true, TAIPEI)).toBe(Date.UTC(2026, 8, 18, 16));
    expect(msToDayInput(Date.UTC(2026, 8, 18, 16), true, TAIPEI)).toBe("2026-09-18");
    expect(msToDayInput(Date.UTC(2026, 8, 17, 16), false, TAIPEI)).toBe("2026-09-18");
  });

  it("相對時間超過一週改顯示日期時,用站台時區", () => {
    const now = JUST_AFTER_MIDNIGHT + 30 * 86_400_000;
    expect(relativeTimeWords(JUST_AFTER_MIDNIGHT, now, "zh-Hant", TAIPEI)).toBe("9月18日");
  });
});
