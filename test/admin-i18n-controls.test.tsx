import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 中文後台不該冒出英文:月曆的月份與星期、時間欄的 AM/PM、媒體欄位與選檔對話框、
// 宣告式列表的狀態欄與分頁計數。欄位元件也用在公開表單(沒有 I18nProvider),
// 所以語系從 ExtLocaleProvider 拿;兩個 provider 都沒有時是英文。

vi.mock("@/ext/dx/views/collection/useCollectionParams", () => ({
  useCollectionParams: () => ({ setParam: () => {} }),
}));

import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { getMessages, type Locale } from "@/lib/i18n/index";
import { ExtLocaleProvider } from "@/ext/dx/ext-locale";
import { Calendar } from "@/components/ui/calendar";
import { TimeInput } from "@/components/ui/time-input";
import { MediaField } from "@/ext/dx/fields/MediaField";
import { DateField } from "@/ext/dx/fields/DateField";
import { renderCell } from "@/ext/dx/views/collection/cell-renderers";
import { CollectionPagination } from "@/ext/dx/views/collection/CollectionPagination";
import type { DeclarativeField } from "@/ext/dx/manifest";

const inAdmin = (locale: Locale, child: ReactNode) =>
  createElement(I18nProvider, { locale, messages: getMessages(locale) }, child);

const SEPTEMBER = new Date(2026, 8, 1);

describe("Calendar", () => {
  it("中文後台:月份與星期是中文", () => {
    const html = renderToStaticMarkup(inAdmin("zh-Hant", createElement(Calendar, { mode: "single", defaultMonth: SEPTEMBER })));
    expect(html).toContain("2026年9月");
    expect(html).not.toContain("September");
    expect(html).not.toMatch(/>Su<|>Mo</);
  });

  it("沒有語系的地方維持英文", () => {
    const html = renderToStaticMarkup(createElement(Calendar, { mode: "single", defaultMonth: SEPTEMBER }));
    expect(html).toContain("September 2026");
  });
});

describe("TimeInput", () => {
  it("24 小時制,沒有 AM/PM,時與分各一個選單", () => {
    const html = renderToStaticMarkup(
      inAdmin("zh-Hant", createElement(TimeInput, { value: "23:59", onChange: () => {}, "aria-label": "發布時間" })),
    );
    expect(html).toContain('aria-label="發布時間"');
    expect(html).toContain('aria-label="時"');
    expect(html).toContain('aria-label="分"');
    expect(html).toContain('<option value="00">00</option>');
    expect(html).toContain('<option value="23" selected="">23</option>');
    expect(html).toContain('<option value="59" selected="">59</option>');
    expect(html).not.toMatch(/AM|PM/);
  });
});

const mediaField = { key: "cover", type: "media", label: "商品圖" } as DeclarativeField;
const renderMedia = () =>
  createElement(MediaField, { value: "", onChange: () => {}, field: mediaField } as never);

describe("MediaField", () => {
  it("公開表單的樹(只有 ExtLocaleProvider)也是中文", () => {
    const html = renderToStaticMarkup(createElement(ExtLocaleProvider, { locale: "zh-Hant" }, renderMedia()));
    for (const word of ["預覽", "檔案資訊", "手動輸入", "選擇檔案", "還沒有圖片"]) expect(html).toContain(word);
    for (const word of ["Cover", "Library", "Manual", "Choose", "No cover image yet"]) expect(html).not.toContain(word);
  });

  it("沒有 ExtLocaleProvider 時跟著後台語系", () => {
    const html = renderToStaticMarkup(inAdmin("zh-Hant", renderMedia()));
    expect(html).toContain("選擇檔案");
  });

  it("兩個都沒有時是英文", () => {
    const html = renderToStaticMarkup(renderMedia());
    expect(html).toContain("Choose");
  });
});

describe("DateField", () => {
  it("沒選日期時的提示跟著欄位語系", () => {
    const field = { key: "day", type: "date", label: "日期" } as DeclarativeField;
    const html = renderToStaticMarkup(
      createElement(ExtLocaleProvider, { locale: "zh-Hant" }, createElement(DateField, { value: undefined, onChange: () => {}, field } as never)),
    );
    expect(html).toContain("選擇日期");
    expect(html).not.toContain("Pick a date");
  });
});

describe("collection list", () => {
  it("是／否與筆數用後台語系", () => {
    const bool = { key: "on", type: "boolean", label: "啟用" } as DeclarativeField;
    const rows = { key: "rows", type: "repeater", label: "列", fields: [] } as unknown as DeclarativeField;
    expect(renderToStaticMarkup(createElement("div", null, renderCell(bool, true, undefined, "zh-Hant")))).toContain(">是<");
    expect(renderToStaticMarkup(createElement("div", null, renderCell(rows, [{}, {}], undefined, "zh-Hant")))).toContain("2 項");
    expect(renderToStaticMarkup(createElement("div", null, renderCell(bool, false)))).toContain(">no<");
  });

  it("分頁計數是一句中文", () => {
    const html = renderToStaticMarkup(
      inAdmin("zh-Hant", createElement(CollectionPagination, { page: 1, perPage: 20, total: 4, count: 4 })),
    );
    expect(html).toContain("第 1–4 筆，共 ");
    expect(html).not.toContain(" of ");
  });
});
