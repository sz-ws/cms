import { describe, expect, it } from "vitest";
import {
  isIsoDay,
  isNoticeLink,
  isPlainLine,
  resolveSiteNotice,
  SITE_NOTICE_KEYS,
  SITE_NOTICE_MAX_LENGTH,
} from "../src/lib/site-notice";
import { validateSettingValue, type SettingValueField } from "../src/lib/setting-validation";
import { CORE_SETTINGS } from "../src/lib/settings";
import { zonedTimeToMs } from "../src/lib/datetime";

// 1.56.0 網站公告:設定頁的欄位驗證與 getSiteNotice 的日期判斷(純函式部分)。

const TZ = "Asia/Taipei";
const at = (year: number, month: number, day: number, hour = 0, minute = 0) =>
  zonedTimeToMs({ year, month, day, hour, minute }, TZ);

describe("site notice rules", () => {
  it("accepts site paths and https addresses only", () => {
    expect(isNoticeLink("/products")).toBe(true);
    expect(isNoticeLink("/blog/new-year?ref=top#menu")).toBe(true);
    expect(isNoticeLink("https://example.com/sale")).toBe(true);
    for (const bad of [
      "//evil.example",
      "/\\evil.example",
      "http://example.com",
      "javascript:alert(1)",
      "data:text/html,hi",
      "https://user:pw@example.com",
      "https://",
      " /products",
      "/a path",
      "products",
    ]) {
      expect(isNoticeLink(bad), bad).toBe(false);
    }
  });

  it("keeps the text to one line of plain text", () => {
    expect(isPlainLine("中秋節 9/15–9/17 公休")).toBe(true);
    expect(isPlainLine("滿 1000 免運,買 >2 件再折 50")).toBe(true);
    expect(isPlainLine("<b>sale</b>")).toBe(false);
    expect(isPlainLine("a</a>")).toBe(false);
    expect(isPlainLine("line one\nline two")).toBe(false);
  });

  it("only takes real calendar days", () => {
    expect(isIsoDay("2026-02-28")).toBe(true);
    expect(isIsoDay("2028-02-29")).toBe(true);
    expect(isIsoDay("2026-02-31")).toBe(false);
    expect(isIsoDay("2026-2-3")).toBe(false);
    expect(isIsoDay("2026/02/03")).toBe(false);
  });
});

describe("resolveSiteNotice", () => {
  const base = { enabled: true, text: "  中秋節公休三天  " };

  it("is null when switched off or empty", () => {
    const now = at(2026, 9, 27, 12);
    expect(resolveSiteNotice({ ...base, enabled: false }, now, TZ)).toBeNull();
    expect(resolveSiteNotice({ ...base, enabled: "true" }, now, TZ)).toBeNull();
    expect(resolveSiteNotice({ enabled: true, text: "   " }, now, TZ)).toBeNull();
    expect(resolveSiteNotice({ enabled: true }, now, TZ)).toBeNull();
  });

  it("trims the text and keeps a valid link", () => {
    const now = at(2026, 9, 27, 12);
    expect(resolveSiteNotice(base, now, TZ)).toEqual({ text: "中秋節公休三天" });
    expect(resolveSiteNotice({ ...base, href: "/blog" }, now, TZ)).toEqual({
      text: "中秋節公休三天",
      href: "/blog",
    });
    // 壞掉的連結不讓公告消失,只是不當連結。
    expect(resolveSiteNotice({ ...base, href: "javascript:alert(1)" }, now, TZ)).toEqual({
      text: "中秋節公休三天",
    });
  });

  it("drops text that breaks the rules even if it reached the database", () => {
    const now = at(2026, 9, 27, 12);
    expect(resolveSiteNotice({ enabled: true, text: "<script>x</script>" }, now, TZ)).toBeNull();
    expect(
      resolveSiteNotice({ enabled: true, text: "字".repeat(SITE_NOTICE_MAX_LENGTH + 1) }, now, TZ),
    ).toBeNull();
    expect(
      resolveSiteNotice({ enabled: true, text: "字".repeat(SITE_NOTICE_MAX_LENGTH) }, now, TZ),
    ).not.toBeNull();
  });

  it("starts at midnight of the start day in the site time zone", () => {
    const values = { ...base, startsOn: "2026-10-01" };
    expect(resolveSiteNotice(values, at(2026, 9, 30, 23, 59), TZ)).toBeNull();
    expect(resolveSiteNotice(values, at(2026, 10, 1, 0, 0), TZ)).not.toBeNull();
    // 台北 10/1 00:00 = UTC 9/30 16:00:UTC 還是 9/30 也已經開始。
    expect(resolveSiteNotice(values, Date.UTC(2026, 8, 30, 16, 0), TZ)).not.toBeNull();
  });

  it("stays up through the whole end day", () => {
    const values = { ...base, endsOn: "2026-10-03" };
    expect(resolveSiteNotice(values, at(2026, 10, 3, 23, 59), TZ)).not.toBeNull();
    expect(resolveSiteNotice(values, at(2026, 10, 4, 0, 0), TZ)).toBeNull();
  });

  it("shows only inside the window when both dates are set", () => {
    const values = { ...base, startsOn: "2026-10-01", endsOn: "2026-10-03" };
    expect(resolveSiteNotice(values, at(2026, 9, 30, 12), TZ)).toBeNull();
    expect(resolveSiteNotice(values, at(2026, 10, 2, 12), TZ)).not.toBeNull();
    expect(resolveSiteNotice(values, at(2026, 10, 4, 12), TZ)).toBeNull();
    // 結束日早於開始日:永遠不顯示。
    const reversed = { ...base, startsOn: "2026-10-03", endsOn: "2026-10-01" };
    expect(resolveSiteNotice(reversed, at(2026, 10, 2, 12), TZ)).toBeNull();
  });

  it("hides the notice when a stored date is broken", () => {
    const now = at(2026, 9, 27, 12);
    expect(resolveSiteNotice({ ...base, startsOn: "2026-02-31" }, now, TZ)).toBeNull();
    expect(resolveSiteNotice({ ...base, endsOn: "soon" }, now, TZ)).toBeNull();
    // 空字串 = 沒設。
    expect(resolveSiteNotice({ ...base, startsOn: "", endsOn: "" }, now, TZ)).not.toBeNull();
  });
});

describe("site notice settings", () => {
  const field = (key: string) => {
    const found = CORE_SETTINGS.find((f) => f.key === key);
    if (!found) throw new Error(`missing setting ${key}`);
    return found as SettingValueField;
  };

  it("registers the five fields in the notice group, off by default", () => {
    const keys = Object.values(SITE_NOTICE_KEYS);
    const fields = CORE_SETTINGS.filter((f) => keys.includes(f.key as (typeof keys)[number]));
    expect(fields.map((f) => f.key)).toEqual(keys);
    expect(fields.every((f) => f.group === "notice")).toBe(true);
    expect(field(SITE_NOTICE_KEYS.enabled).type).toBe("boolean");
    expect(CORE_SETTINGS.find((f) => f.key === SITE_NOTICE_KEYS.enabled)?.default).toBe(false);
  });

  it("validates the text length and plain text", () => {
    const text = field(SITE_NOTICE_KEYS.text);
    expect(validateSettingValue(text, "中秋節公休")).toBeNull();
    expect(validateSettingValue(text, "")).toBeNull();
    expect(validateSettingValue(text, "字".repeat(SITE_NOTICE_MAX_LENGTH))).toBeNull();
    expect(validateSettingValue(text, "字".repeat(SITE_NOTICE_MAX_LENGTH + 1))).toBe("too_long");
    expect(validateSettingValue(text, "<a href=x>hi</a>")).toBe("not_plain_text");
    expect(validateSettingValue(text, "one\ntwo")).toBe("not_plain_text");
    expect(validateSettingValue(text, 12)).toBe("expected_string");
  });

  it("validates the link and the dates", () => {
    const href = field(SITE_NOTICE_KEYS.href);
    expect(validateSettingValue(href, "/products")).toBeNull();
    expect(validateSettingValue(href, "https://example.com")).toBeNull();
    expect(validateSettingValue(href, "")).toBeNull();
    expect(validateSettingValue(href, "javascript:alert(1)")).toBe("invalid_link");
    expect(validateSettingValue(href, "//evil.example")).toBe("invalid_link");

    for (const key of [SITE_NOTICE_KEYS.startsOn, SITE_NOTICE_KEYS.endsOn]) {
      expect(validateSettingValue(field(key), "2026-10-01")).toBeNull();
      expect(validateSettingValue(field(key), "")).toBeNull();
      expect(validateSettingValue(field(key), "2026-02-31")).toBe("invalid_date");
      expect(validateSettingValue(field(key), "next week")).toBe("invalid_date");
    }
  });

  it("leaves plain text settings without a format alone", () => {
    const title = field("core.siteTitle");
    expect(validateSettingValue(title, "<b>My</b>\nSite")).toBeNull();
  });
});
