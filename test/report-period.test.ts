import { describe, expect, it } from "vitest";
import {
  addDays,
  customPeriodProblem,
  daySpan,
  listDays,
  parseReportPeriod,
  periodFromRange,
  previousPeriod,
  reportPeriodParams,
  withReportPeriod,
} from "../src/lib/report-period";
import {
  axisTickDays,
  dailyRows,
  periodLabel,
  revenueChange,
  shortDay,
} from "../src/components/admin/report/revenue-summary";

// 1.61.0:報表的期間(儀表板的營業額卡與插件的報表共用)與圖的純函式。

const TPE = "Asia/Taipei";
// 2026-09-23 12:00 台北。
const NOW = Date.UTC(2026, 8, 23, 4, 0);
const params = (query: string) => new URLSearchParams(query);

describe("presets", () => {
  it("defaults to the 30 days ending today, whole days in the site time zone", () => {
    const period = parseReportPeriod(params(""), NOW, TPE);
    expect(period).toMatchObject({ preset: 30, from: "2026-08-25", to: "2026-09-23", timeZone: TPE });
    expect(period.days).toHaveLength(30);
    expect(period.days[0]).toBe("2026-08-25");
    expect(period.days.at(-1)).toBe("2026-09-23");
    // 台北 8/25 00:00 = 8/24 16:00Z;9/23 隔天 00:00 = 9/23 16:00Z(不含)。
    expect(period.start).toBe(Date.UTC(2026, 7, 24, 16));
    expect(period.end).toBe(Date.UTC(2026, 8, 23, 16));
  });

  it("reads 7 and 90, and ignores anything else", () => {
    expect(parseReportPeriod(params("range=7"), NOW, TPE)).toMatchObject({ preset: 7, from: "2026-09-17", to: "2026-09-23" });
    expect(parseReportPeriod(params("range=90"), NOW, TPE)).toMatchObject({ preset: 90, from: "2026-06-26" });
    for (const bad of ["range=14", "range=7d", "range=", "range=-7", "range=30.0"]) {
      expect(parseReportPeriod(params(bad), NOW, TPE).preset, bad).toBe(30);
    }
  });

  it("takes Next's searchParams objects too (first value of a repeated param)", () => {
    expect(parseReportPeriod({ range: ["7", "90"] }, NOW, TPE).preset).toBe(7);
    expect(parseReportPeriod({ since: "2026-09-01", until: "2026-09-10" }, NOW, TPE)).toMatchObject({ preset: "custom", from: "2026-09-01" });
    expect(parseReportPeriod({}, NOW, TPE).preset).toBe(30);
  });
});

describe("custom ranges", () => {
  it("uses since..until, both days included", () => {
    const period = parseReportPeriod(params("since=2026-09-01&until=2026-09-10&range=7"), NOW, TPE);
    expect(period).toMatchObject({ preset: "custom", from: "2026-09-01", to: "2026-09-10" });
    expect(period.days).toHaveLength(10);
    expect(period.end - period.start).toBe(10 * 86_400_000);
  });

  it("allows a single day, today, and exactly 366 days", () => {
    expect(parseReportPeriod(params("since=2026-09-23&until=2026-09-23"), NOW, TPE).days).toEqual(["2026-09-23"]);
    const year = parseReportPeriod(params("since=2025-09-23&until=2026-09-23"), NOW, TPE);
    expect(year.preset).toBe("custom");
    expect(year.days).toHaveLength(366);
  });

  it.each([
    ["since after until", "since=2026-09-10&until=2026-09-01"],
    ["until after today", "since=2026-09-20&until=2026-09-24"],
    ["more than 366 days", "since=2025-09-22&until=2026-09-23"],
    ["a date that does not exist", "since=2026-02-30&until=2026-03-01"],
    ["not a date", "since=yesterday&until=2026-09-01"],
    ["only one end", "since=2026-09-01"],
  ])("falls back when %s", (_label, query) => {
    expect(parseReportPeriod(params(query), NOW, TPE).preset).toBe(30);
    // range 還在的話用 range。
    expect(parseReportPeriod(params(`${query}&range=7`), NOW, TPE).preset).toBe(7);
  });

  it("says what is wrong with a custom range", () => {
    expect(customPeriodProblem("", "2026-09-01", "2026-09-23")).toBe("missing");
    expect(customPeriodProblem("2026-09-10", "2026-09-01", "2026-09-23")).toBe("order");
    expect(customPeriodProblem("2026-09-10", "2026-09-24", "2026-09-23")).toBe("future");
    expect(customPeriodProblem("2025-01-01", "2026-09-01", "2026-09-23")).toBe("length");
    expect(customPeriodProblem("2026-09-01", "2026-09-23", "2026-09-23")).toBeNull();
  });
});

describe("time zones", () => {
  it("today is the site's today, not UTC's", () => {
    // 9/22 17:00Z = 台北 9/23 01:00,紐約 9/22 13:00。
    const late = Date.UTC(2026, 8, 22, 17);
    expect(parseReportPeriod(params("range=7"), late, TPE).to).toBe("2026-09-23");
    expect(parseReportPeriod(params("range=7"), late, "America/New_York").to).toBe("2026-09-22");
    // 台北 9/23 00:00 前一刻還是 9/22。
    expect(parseReportPeriod(params("range=7"), Date.UTC(2026, 8, 22, 15, 59, 59), TPE).to).toBe("2026-09-22");
  });

  it("a day across a daylight-saving change is 25 hours long, and days still meet end to end", () => {
    // 紐約 2026-11-01 回到標準時間。
    const period = parseReportPeriod(params("since=2026-10-31&until=2026-11-02"), Date.UTC(2026, 10, 5), "America/New_York");
    expect(period.start).toBe(Date.UTC(2026, 9, 31, 4));
    expect(period.end).toBe(Date.UTC(2026, 10, 3, 5));
    expect(period.end - period.start).toBe(3 * 86_400_000 + 3_600_000);
  });

  it("an unknown time zone is treated as Taipei", () => {
    expect(parseReportPeriod(params(""), NOW, "Not/AZone").timeZone).toBe(TPE);
  });
});

describe("the previous period", () => {
  it("is the same length and ends where this one starts", () => {
    const period = parseReportPeriod(params(""), NOW, TPE);
    const previous = previousPeriod(period);
    expect(previous).toMatchObject({ from: "2026-07-26", to: "2026-08-24" });
    expect(previous.days).toHaveLength(30);
    expect(previous.end).toBe(period.start);
  });

  it("works for custom ranges across a month and a year", () => {
    const period = parseReportPeriod(params("since=2026-01-01&until=2026-01-10"), NOW, TPE);
    expect(previousPeriod(period)).toMatchObject({ from: "2025-12-22", to: "2025-12-31" });
    const leap = parseReportPeriod(params("since=2024-03-01&until=2024-03-01"), NOW, TPE);
    expect(previousPeriod(leap)).toMatchObject({ from: "2024-02-29", to: "2024-02-29" });
  });
});

describe("carrying the period in links", () => {
  it("writes range for presets and since/until for custom ranges", () => {
    expect(reportPeriodParams({ preset: 30, from: "x", to: "y" })).toEqual({ range: "30" });
    expect(reportPeriodParams({ preset: "custom", from: "2026-09-01", to: "2026-09-10" })).toEqual({ since: "2026-09-01", until: "2026-09-10" });
    expect(withReportPeriod("/admin/ext/shop/report", { preset: 7, from: "", to: "" })).toBe("/admin/ext/shop/report?range=7");
    expect(withReportPeriod("/admin/ext/dealer?tab=purchases", { preset: "custom", from: "2026-09-01", to: "2026-09-02" })).toBe(
      "/admin/ext/dealer?tab=purchases&since=2026-09-01&until=2026-09-02",
    );
  });

  it("turns a plugin's from..to back into the same period", () => {
    const at = { now: NOW, timeZone: TPE };
    expect(periodFromRange({ ...at, from: "2026-08-25", to: "2026-09-23" })).toEqual({ preset: 30, from: "2026-08-25", to: "2026-09-23" });
    expect(periodFromRange({ ...at, from: "2026-09-17", to: "2026-09-23" }).preset).toBe(7);
    // 前一段(不到今天)、長度不是 7 / 30 / 90 的都是自訂。
    expect(periodFromRange({ ...at, from: "2026-08-18", to: "2026-08-24" }).preset).toBe("custom");
    expect(periodFromRange({ ...at, from: "2026-09-10", to: "2026-09-23" }).preset).toBe("custom");
    const period = parseReportPeriod(params("range=90"), NOW, TPE);
    expect(reportPeriodParams(periodFromRange({ ...at, from: period.from, to: period.to }))).toEqual({ range: "90" });
  });

  it("day arithmetic", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2024-12-31", 1)).toBe("2025-01-01");
    expect(daySpan("2026-09-01", "2026-09-30")).toBe(30);
    expect(listDays("2026-09-29", "2026-10-01")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01"]);
    expect(listDays("2026-10-01", "2026-09-29")).toEqual([]);
  });
});

describe("chart helpers", () => {
  it("one row per day with each series and the day's total", () => {
    const rows = dailyRows(["2026-09-01", "2026-09-02"], [
      { key: "a/x", label: "A", days: { "2026-09-01": 100 } },
      { key: "b/y", label: "B", days: { "2026-09-01": 50, "2026-09-02": 20 } },
    ]);
    expect(rows).toEqual([
      { day: "2026-09-01", total: 150, s0: 100, s1: 50 },
      { day: "2026-09-02", total: 20, s0: 0, s1: 20 },
    ]);
  });

  it("labels every day up to 10 days, about six otherwise, always the last day", () => {
    const week = listDays("2026-09-17", "2026-09-23");
    expect(axisTickDays(week).size).toBe(7);
    for (const length of [30, 90, 366]) {
      const days = listDays(addDays("2026-09-23", 1 - length), "2026-09-23");
      const ticks = axisTickDays(days);
      expect(ticks.has("2026-09-23"), `${length}`).toBe(true);
      expect(ticks.size, `${length}`).toBeGreaterThanOrEqual(5);
      expect(ticks.size, `${length}`).toBeLessThanOrEqual(7);
    }
    expect(shortDay("2026-09-03")).toBe("9/3");
  });

  it("compares with the previous period in whole percent, and not at all against zero", () => {
    expect(revenueChange(1200, 1000)).toEqual({ percent: 20, direction: "up" });
    expect(revenueChange(500, 1000)).toEqual({ percent: 50, direction: "down" });
    expect(revenueChange(1000, 1000)).toEqual({ percent: 0, direction: "flat" });
    expect(revenueChange(1001, 1000)).toEqual({ percent: 0, direction: "flat" });
    expect(revenueChange(0, 1000)).toEqual({ percent: 100, direction: "down" });
    expect(revenueChange(1000, 0)).toBeNull();
  });

  it("writes the period short this year and with years otherwise", () => {
    expect(periodLabel("2026-09-01", "2026-09-30", "2026-09-30", "zh-Hant")).toBe("9/1 – 9/30");
    expect(periodLabel("2026-09-01", "2026-09-30", "2026-09-30", "en")).toBe("9/1 – 9/30");
    expect(periodLabel("2025-12-15", "2026-01-14", "2026-09-30", "zh-Hant")).toBe("2025/12/15 – 2026/1/14");
    expect(periodLabel("2026-09-23", "2026-09-23", "2026-09-30", "en")).toBe("9/23");
  });
});
